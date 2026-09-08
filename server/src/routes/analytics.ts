import { Router } from 'express';
import { query, withTx } from '../db.js';
import { requireOwner } from '../lib/auth.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';

export const analyticsRouter = Router();

// Аналитика — только владелец (закупочные цены, маржа, потери).
analyticsRouter.use(requireOwner);

// «Пора закупить»: остаток ниже или равен минимуму.
// Считаем средний расход в день за 30 дней, чтобы прикинуть, на сколько хватит.
analyticsRouter.get('/restock', async (_req, res) => {
  const rows = await query(
    `WITH sold AS (
       SELECT si.product_id, SUM(si.qty) AS qty_30d
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
        WHERE s.created_at >= now() - interval '30 days'
        GROUP BY si.product_id
     )
     SELECT p.id, p.barcode, p.name, p.category, p.stock, p.min_stock, p.cost_price,
            COALESCE(sold.qty_30d, 0) AS sold_30d,
            -- Прогноз имеет смысл только если товар продавался регулярно.
            -- Для одной-двух продаж за месяц он вводит в заблуждение (п.25).
            CASE WHEN COALESCE(sold.qty_30d,0) >= 5
                 THEN ROUND(p.stock / (sold.qty_30d / 30.0), 1)
                 ELSE NULL END AS days_left
       FROM products p
       LEFT JOIN sold ON sold.product_id = p.id
      WHERE p.is_archived = false
        AND p.min_stock > 0
        AND p.stock <= p.min_stock
      ORDER BY (p.stock - p.min_stock), p.name`,
  );
  res.json(rows);
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
     SELECT p.id, p.barcode, p.name, p.category, p.stock, p.cost_price, p.sale_price,
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
