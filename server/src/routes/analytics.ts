import { Router } from 'express';
import { query, withTx } from '../db.js';
import { requireOwner } from '../lib/auth.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';

export const analyticsRouter = Router();

// Аналитика — только владелец (закупочные цены, маржа, потери).
analyticsRouter.use(requireOwner);

// Прогноз «закончится через N дней» поднимает тревогу даже без заданного
// минимума: у нового магазина минимумы обычно никто не проставил, а ходовой
// товар заканчивается за пару дней. Заказ советуем на COVER_DAYS вперёд.
const RESTOCK_ALERT_DAYS = 3;
const RESTOCK_COVER_DAYS = 7;

// «Пора закупить»: остаток на минимуме или ниже, либо по темпу продаж
// товара хватит меньше чем на RESTOCK_ALERT_DAYS дней.
analyticsRouter.get('/restock', async (_req, res) => {
  const rows = await query(
    `WITH observed AS (
       -- Сколько дней магазин реально торгует (в пределах 30). Делить на 30
       -- у магазина, открытого неделю назад, — занизить расход в 4 раза.
       -- Не меньше 3 дней, чтобы первый день торговли не давал бешеный темп.
       SELECT GREATEST(LEAST(EXTRACT(EPOCH FROM now() - MIN(created_at)) / 86400.0, 30), 3) AS days
         FROM sales
        WHERE created_at >= now() - interval '30 days'
     ),
     sold AS (
       SELECT si.product_id, SUM(si.qty) AS qty_30d
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
        WHERE s.created_at >= now() - interval '30 days'
        GROUP BY si.product_id
     ),
     calc AS (
       SELECT p.id, p.barcode, p.name, p.category, p.stock, p.min_stock, p.cost_price, p.unit,
              COALESCE(sold.qty_30d, 0) AS sold_30d,
              -- Прогноз имеет смысл только если товар продавался регулярно.
              -- Для одной-двух продаж за месяц он вводит в заблуждение (п.25).
              CASE WHEN COALESCE(sold.qty_30d,0) >= 5
                   THEN sold.qty_30d / observed.days
                   ELSE NULL END AS per_day
         FROM products p
         CROSS JOIN observed
         LEFT JOIN sold ON sold.product_id = p.id
        WHERE p.is_archived = false
     )
     SELECT id, barcode, name, category, stock, min_stock, cost_price, unit, sold_30d,
            ROUND(per_day, 2) AS per_day,
            CASE WHEN per_day IS NOT NULL THEN ROUND(GREATEST(stock, 0) / per_day, 1) END AS days_left,
            (min_stock > 0 AND stock <= min_stock) AS below_min,
            -- Сколько заказать, чтобы хватило на неделю (и не меньше минимума).
            CASE WHEN per_day IS NOT NULL
                 THEN GREATEST(CEIL(per_day * ${RESTOCK_COVER_DAYS} - GREATEST(stock, 0)),
                               CEIL(min_stock - stock), 0)
                 ELSE GREATEST(CEIL(min_stock - stock), 0) END AS suggest_qty
       FROM calc
      WHERE (min_stock > 0 AND stock <= min_stock)
         OR (per_day IS NOT NULL AND GREATEST(stock, 0) / per_day < ${RESTOCK_ALERT_DAYS})
      ORDER BY COALESCE(GREATEST(stock, 0) / per_day, 999), (stock - min_stock), name`,
  );
  res.json(rows);
});

// «Ходовые»: что продаётся чаще всего и быстрее всего уходит со склада.
// По каждому товару за период: в скольких чеках был (как часто берут),
// сколько продано, темп в день, выручка, маржа и на сколько хватит остатка.
// Сортирует экран — сервер отдаёт все проданные за период позиции.
analyticsRouter.get('/movers', async (req, res) => {
  const days = basketDays(req.query.days);
  const rows = await query(
    `WITH observed AS (
       -- Темп в день — по дням, которые магазин реально торговал в периоде,
       -- а не по длине периода: иначе у нового магазина он занижен.
       SELECT GREATEST(LEAST(EXTRACT(EPOCH FROM now() - MIN(created_at)) / 86400.0, $1::numeric), 1) AS days
         FROM sales
        WHERE created_at >= now() - ($1 || ' days')::interval
     )
     SELECT p.id, p.name, p.category, p.unit, p.stock, p.sale_price,
            COUNT(DISTINCT si.sale_id) AS receipts,
            SUM(si.qty) AS qty,
            ROUND(SUM(si.qty) / MAX(observed.days), 2) AS per_day,
            SUM(si.line_total) AS revenue,
            SUM(si.line_total - si.unit_cost * si.qty) AS margin,
            CASE WHEN SUM(si.line_total) > 0
                 THEN ROUND(100 * SUM(si.line_total - si.unit_cost * si.qty) / SUM(si.line_total), 1)
                 END AS margin_pct,
            CASE WHEN SUM(si.qty) > 0
                 THEN ROUND(GREATEST(p.stock, 0) / (SUM(si.qty) / MAX(observed.days)), 1)
                 END AS days_left
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
       CROSS JOIN observed
      WHERE s.created_at >= now() - ($1 || ' days')::interval
      GROUP BY p.id
      ORDER BY receipts DESC, qty DESC`,
    [String(days)],
  );
  res.json(
    rows.map((r: any) => ({ ...r, receipts: Number(r.receipts) })),
  );
});

// «Что покупают вместе». Обзор: по каждому ходовому товару — в скольких
// чеках он был и в какой доле из них взяли что-то ещё. Плюс общие цифры
// по чекам: среднее число позиций и доля чеков из одного товара.
// days — за сколько последних дней считать (по умолчанию 30).
function basketDays(raw: unknown): number {
  return Math.min(Math.max(Number(raw) || 30, 1), 365);
}

analyticsRouter.get('/basket', async (req, res) => {
  const days = basketDays(req.query.days);
  const since = [String(days)];

  // Позиции считаем как разные товары в чеке, а не сумму qty:
  // 3 Pepsi или 0,5 кг курута — это одна позиция.
  const totals = (
    await query(
      `WITH per_sale AS (
         SELECT s.id, s.total, COUNT(DISTINCT si.product_id) AS positions
           FROM sales s
           JOIN sale_items si ON si.sale_id = s.id
          WHERE s.created_at >= now() - ($1 || ' days')::interval
          GROUP BY s.id, s.total
       )
       SELECT COUNT(*) AS receipts,
              COALESCE(ROUND(AVG(positions), 2), 0) AS avg_positions,
              COALESCE(ROUND(AVG(total), 2), 0) AS avg_check,
              COUNT(*) FILTER (WHERE positions = 1) AS single_receipts
         FROM per_sale`,
      since,
    )
  )[0];

  const products = await query(
    `WITH per_sale AS (
       SELECT s.id, s.total, COUNT(DISTINCT si.product_id) AS positions
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
        WHERE s.created_at >= now() - ($1 || ' days')::interval
        GROUP BY s.id, s.total
     ),
     anchor AS (
       SELECT DISTINCT si.product_id, si.sale_id
         FROM sale_items si
         JOIN per_sale ps ON ps.id = si.sale_id
     )
     SELECT p.id, p.name, p.unit,
            COUNT(*) AS receipts,
            COUNT(*) FILTER (WHERE ps.positions > 1) AS with_others,
            ROUND(100.0 * COUNT(*) FILTER (WHERE ps.positions > 1) / COUNT(*), 0) AS attach_pct,
            ROUND(AVG(ps.total), 2) AS avg_check
       FROM anchor a
       JOIN per_sale ps ON ps.id = a.sale_id
       JOIN products p ON p.id = a.product_id
      GROUP BY p.id, p.name, p.unit
      ORDER BY receipts DESC, p.name
      LIMIT 30`,
    since,
  );

  res.json({
    days,
    receipts: Number(totals.receipts),
    avg_positions: Number(totals.avg_positions),
    avg_check: Number(totals.avg_check),
    single_receipts: Number(totals.single_receipts),
    products,
  });
});

// Детально по одному товару: с чем его берут. share — доля чеков с товаром,
// в которых был и сопутствующий. Маржа — только по сопутствующему товару:
// именно её «привёл» товар-магнит.
analyticsRouter.get('/basket/:productId', async (req, res) => {
  const days = basketDays(req.query.days);
  // Кривой id не должен превращаться в 500 от Postgres.
  if (!/^[0-9a-f-]{36}$/i.test(req.params.productId)) {
    return res.status(404).json({ error: 'Товар не найден' });
  }
  const params = [req.params.productId, String(days)];

  const anchor = (
    await query(
      `WITH sales_with AS (
         SELECT DISTINCT s.id, s.total
           FROM sales s
           JOIN sale_items si ON si.sale_id = s.id
          WHERE si.product_id = $1
            AND s.created_at >= now() - ($2 || ' days')::interval
       )
       SELECT p.id, p.name, p.unit,
              (SELECT COUNT(*) FROM sales_with) AS receipts,
              (SELECT COUNT(*) FROM sales_with sw
                WHERE EXISTS (SELECT 1 FROM sale_items x
                               WHERE x.sale_id = sw.id AND x.product_id <> $1)) AS with_others,
              (SELECT COALESCE(ROUND(AVG(total), 2), 0) FROM sales_with) AS avg_check
         FROM products p WHERE p.id = $1`,
      params,
    )
  )[0];
  if (!anchor) return res.status(404).json({ error: 'Товар не найден' });

  const companions = await query(
    `WITH sales_with AS (
       SELECT DISTINCT s.id
         FROM sales s
         JOIN sale_items si ON si.sale_id = s.id
        WHERE si.product_id = $1
          AND s.created_at >= now() - ($2 || ' days')::interval
     )
     SELECT si.product_id AS id, MAX(si.name) AS name, MAX(p.unit) AS unit,
            COUNT(DISTINCT si.sale_id) AS receipts,
            SUM(si.qty) AS qty,
            SUM(si.line_total) AS revenue,
            SUM(si.line_total - si.unit_cost * si.qty) AS margin
       FROM sale_items si
       JOIN sales_with sw ON sw.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
      WHERE si.product_id <> $1
      GROUP BY si.product_id
      ORDER BY receipts DESC, revenue DESC
      LIMIT 20`,
    params,
  );

  const receipts = Number(anchor.receipts);
  res.json({
    days,
    product: { id: anchor.id, name: anchor.name, unit: anchor.unit },
    receipts,
    with_others: Number(anchor.with_others),
    attach_pct: receipts ? Math.round((100 * Number(anchor.with_others)) / receipts) : 0,
    avg_check: Number(anchor.avg_check),
    companions: companions.map((c: any) => ({
      ...c,
      receipts: Number(c.receipts),
      share_pct: receipts ? Math.round((100 * Number(c.receipts)) / receipts) : 0,
    })),
  });
});

// «Залежалый товар»: есть остаток, но давно не продавался.
// days — порог «давно» (по умолчанию 30 дней).
analyticsRouter.get('/stale', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const rows = await query(
    `WITH last_sale AS (
       SELECT si.product_id, MAX(s.created_at) AS last_sold_at, SUM(si.qty) AS total_sold
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
        GROUP BY si.product_id
     )
     SELECT p.id, p.barcode, p.name, p.category, p.stock, p.cost_price, p.sale_price, p.unit,
            ls.last_sold_at,
            COALESCE(ls.total_sold, 0) AS total_sold,
            ROUND(p.stock * p.cost_price, 2) AS frozen_money,
            CASE WHEN ls.last_sold_at IS NULL THEN NULL
                 ELSE EXTRACT(DAY FROM now() - ls.last_sold_at)::int END AS days_since_sale
       FROM products p
       LEFT JOIN last_sale ls ON ls.product_id = p.id
      WHERE p.is_archived = false
        AND p.stock > 0
        AND (ls.last_sold_at IS NULL OR ls.last_sold_at < now() - ($1 || ' days')::interval)
      ORDER BY frozen_money DESC`,
    [String(days)],
  );
  res.json(rows);
});

// Массовая смена цен: по категории или по списку товаров.
// Тело: { category?, product_ids?, mode: 'percent'|'set', field: 'sale_price'|'cost_price', value }
analyticsRouter.post('/bulk-price', async (req, res) => {
  const { category, product_ids, mode, field, value } = req.body ?? {};
  if (field !== 'sale_price' && field !== 'cost_price') {
    return res.status(400).json({ error: 'field: sale_price | cost_price' });
  }
  if (mode !== 'percent' && mode !== 'set') {
    return res.status(400).json({ error: 'mode: percent | set' });
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return res.status(400).json({ error: 'value должен быть числом' });
  if (!category && !(Array.isArray(product_ids) && product_ids.length > 0)) {
    return res.status(400).json({ error: 'Нужна category или product_ids' });
  }

  const updated = await withTx(async (client) => {
    const filter = category ? `category = $1` : `id = ANY($1::uuid[])`;
    const param = category ? category : product_ids;

    const before = (await client.query(`SELECT id, name, ${field} AS old FROM products WHERE ${filter} AND is_archived = false`, [param])).rows;
    if (before.length === 0) return [];

    const expr =
      mode === 'percent'
        ? `ROUND(${field} * (1 + $2::numeric / 100.0), 2)`
        : `$2::numeric`;

    const rows = (
      await client.query(
        `UPDATE products SET ${field} = ${expr}, updated_at = now()
          WHERE ${filter} AND is_archived = false
          RETURNING *`,
        [param, num],
      )
    ).rows;

    // Каждое изменение цены — отдельная запись в журнал (прозрачность).
    for (const p of rows) {
      const old = before.find((b: any) => b.id === p.id)?.old;
      if (old != null && Number(old) !== Number(p[field])) {
        await writeLog(
          {
            type: 'price_change', entity: 'product', entityId: p.id, userId: req.user!.id,
            details: { field, old: Number(old), new: Number(p[field]), bulk: true },
          },
          client,
        );
      }
    }
    return rows;
  });

  updated.forEach((p: any) => broadcast('product_upsert', p, 'all'));
  res.json({ updated: updated.length, products: updated });
});

// Список категорий (для массовой смены цен).
analyticsRouter.get('/categories', async (_req, res) => {
  const rows = await query(
    `SELECT category, COUNT(*) AS count
       FROM products
      WHERE is_archived = false AND category IS NOT NULL AND category <> ''
      GROUP BY category ORDER BY category`,
  );
  res.json(rows);
});

// Инвентаризация: сохранить пересчёт и показать недостачу.
// Тело: { items: [{ barcode, counted_qty }], note?, apply?: boolean }
// apply=true — привести остатки к посчитанным.
analyticsRouter.post('/inventory', async (req, res) => {
  const { items, note, apply } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Пустая инвентаризация' });
  }

  try {
    const result = await withTx(async (client) => {
      const inv = (
        await client.query(`INSERT INTO inventories (user_id, note) VALUES ($1,$2) RETURNING *`, [
          req.user!.id,
          note ?? null,
        ])
      ).rows[0];

      const lines: any[] = [];
      const changed: any[] = [];

      for (const item of items) {
        const counted = Number(item.counted_qty);
        if (!Number.isFinite(counted) || counted < 0) throw { status: 400, message: 'counted_qty >= 0' };

        const found = await client.query(`SELECT * FROM products WHERE barcode = $1 FOR UPDATE`, [item.barcode]);
        if (found.rows.length === 0) throw { status: 400, message: `Товар не найден: ${item.barcode}` };
        const p = found.rows[0];

        const expected = Number(p.stock);
        const diff = Number((counted - expected).toFixed(3));
        const loss = Number((diff * Number(p.cost_price)).toFixed(2));

        const line = (
          await client.query(
            `INSERT INTO inventory_items
               (inventory_id, product_id, barcode, name, expected_qty, counted_qty, difference, unit_cost, loss_value)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [inv.id, p.id, p.barcode, p.name, expected, counted, diff, p.cost_price, loss],
          )
        ).rows[0];
        lines.push(line);

        if (apply && diff !== 0) {
          const upd = await client.query(
            `UPDATE products SET stock = $2, updated_at = now() WHERE id = $1 RETURNING *`,
            [p.id, counted],
          );
          changed.push(upd.rows[0]);
        }
      }

      const totalLoss = Number(lines.reduce((s, l) => s + Number(l.loss_value), 0).toFixed(2));
      await writeLog(
        {
          type: 'inventory', entity: 'inventory', entityId: inv.id, userId: req.user!.id,
          details: { items: lines.length, total_loss: totalLoss, applied: !!apply },
        },
        client,
      );

      return { inventory: inv, items: lines, total_loss: totalLoss, changed };
    });

    result.changed.forEach((p: any) => broadcast('product_upsert', p, 'all'));
    res.status(201).json(result);
  } catch (err: any) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// История инвентаризаций.
analyticsRouter.get('/inventory', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = await query(
    `SELECT i.*, u.username, u.full_name,
            (SELECT COUNT(*) FROM inventory_items WHERE inventory_id = i.id) AS items,
            (SELECT COALESCE(SUM(loss_value),0) FROM inventory_items WHERE inventory_id = i.id) AS total_loss
       FROM inventories i LEFT JOIN users u ON u.id = i.user_id
      ORDER BY i.created_at DESC LIMIT $1`,
    [limit],
  );
  res.json(rows);
});
