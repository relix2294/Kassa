import { Router } from 'express';
import { query, withTx } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { requireOwner } from '../lib/auth.js';
import { saleFor } from '../lib/sanitize.js';
import { getOpenShift, recomputeClosedShift } from './shifts.js';

export const salesRouter = Router();

// Последние продажи (выручка/история) — только владелец.
salesRouter.get('/', requireOwner, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await query(
    `SELECT s.*, u.username, u.full_name
       FROM sales s LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT $1`,
    [limit],
  );
  res.json(rows);
});

// Хронология чеков — только владелец. Каждый чек с составом (что внутри,
// сколько, по какой цене), временем, кассиром и разбивкой оплаты.
// Фильтры: from/to (ISO-даты), cashier (id кассира); постранично limit/offset.
salesRouter.get('/history', requireOwner, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const conds: string[] = [];
  const params: any[] = [];
  if (req.query.from) {
    params.push(req.query.from);
    conds.push(`s.created_at >= $${params.length}`);
  }
  if (req.query.to) {
    params.push(req.query.to);
    conds.push(`s.created_at < $${params.length}`);
  }
  if (req.query.cashier) {
    params.push(req.query.cashier);
    conds.push(`s.user_id = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  const rows = await query(
    `SELECT s.id, s.created_at, s.total, s.cost_total, s.payment_method,
            s.cash_amount, s.card_amount, s.cash_received, s.change_given,
            u.username, u.full_name,
            COALESCE(
              json_agg(
                json_build_object(
                  'name', si.name, 'barcode', si.barcode, 'qty', si.qty,
                  'unit_price', si.unit_price, 'line_total', si.line_total
                ) ORDER BY si.id
              ) FILTER (WHERE si.id IS NOT NULL), '[]'
            ) AS items
       FROM sales s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN sale_items si ON si.sale_id = s.id
       ${where}
      GROUP BY s.id, u.username, u.full_name
      ORDER BY s.created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  res.json(rows);
});

// Провести продажу (чек).
// Тело: { client_id, items:[{barcode, qty}], payment_method, cash_received?, user_id }
salesRouter.post('/', async (req, res) => {
  const { client_id, items, payment_method, cash_received, card_amount, shift_id } = req.body ?? {};
  const user_id = req.user!.id;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Пустой чек' });
  }
  if (payment_method !== 'cash' && payment_method !== 'card' && payment_method !== 'mixed') {
    return res.status(400).json({ error: 'payment_method: cash | card | mixed' });
  }

  // Идемпотентность: тот же чек не проводим дважды (повтор из outbox при обрыве).
  if (client_id) {
    const existing = await query(`SELECT * FROM sales WHERE client_id = $1`, [client_id]);
    if (existing.length > 0) {
      return res.status(200).json({ sale: saleFor(req, existing[0]), duplicate: true });
    }
  }

  // Чек принадлежит той смене, в которую его пробили. Касса присылает свой
  // shift_id — тогда отложенный при обрыве сети чек попадёт в нужную смену,
  // даже если она уже закрыта, и не потеряется.
  let shift: any = null;
  let lateToClosedShift = false;

  if (shift_id) {
    const rows = await query(`SELECT * FROM shifts WHERE id = $1 AND user_id = $2`, [shift_id, user_id]);
    shift = rows[0] ?? null;
    if (!shift) return res.status(400).json({ error: 'Смена не найдена или чужая' });
    lateToClosedShift = shift.status === 'closed';
  } else {
    shift = await getOpenShift(user_id);
    if (!shift) return res.status(409).json({ error: 'no_shift' });
  }

  try {
    const result = await withTx(async (client) => {
      let total = 0;
      let costTotal = 0;
      const changedProducts: any[] = [];
      const lineRows: any[] = [];

      for (const item of items) {
        const qty = Number(item.qty);
        if (!(qty > 0)) throw { status: 400, message: 'qty > 0' };

        // Товар ищем по id либо по штрихкоду: у весового товара и выпечки
        // штрихкода нет вовсе, и касса присылает product_id.
        const found = item.product_id
          ? await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [item.product_id])
          : await client.query(`SELECT * FROM products WHERE barcode = $1 FOR UPDATE`, [item.barcode]);
        if (found.rows.length === 0) {
          throw { status: 400, message: `Товар не найден: ${item.barcode ?? item.product_id}` };
        }
        const p = found.rows[0];

        // Нельзя продать больше, чем есть на складе: минусовой остаток
        // ломает инвентаризацию, «пора закупить» и оценку потерь.
        if (Number(p.stock) < qty) {
          throw {
            status: 400,
            message: `«${p.name}»: на складе ${Number(p.stock)}, продаёте ${qty}. Проверьте остаток или примите товар.`,
          };
        }

        // Базовую цену считаем свою (клиенту доверять нельзя), но сверяем с той,
        // что видел кассир. Если владелец поменял обычную цену, пока чек
        // набирали, — не пробиваем молча другую сумму.
        const basePrice = Number(p.sale_price);
        if (item.expected_price != null && Number(item.expected_price) !== basePrice) {
          throw {
            status: 409,
            message: `Цена «${p.name}» изменилась: было ${item.expected_price}, стало ${basePrice}. Пересоберите чек.`,
          };
        }

        // Скидка владельца применяется автоматически ко всей позиции, пока
        // акция активна — цена в чеке не «переключается» на середине.
        // Лимит — это общий запас акции: он уменьшается на проданное количество
        // и, когда исчерпан, акция заканчивается для следующих чеков.
        const discActive = p.discount_price != null && (p.discount_left == null || Number(p.discount_left) > 0);
        const unitPrice = discActive ? Number(p.discount_price) : basePrice;
        const lineTotal = Number((unitPrice * qty).toFixed(2));

        const unitCost = Number(p.cost_price);
        total += lineTotal;
        costTotal += Number((unitCost * qty).toFixed(2));

        // Списываем остаток; если продали по акции — уменьшаем её запас.
        const upd = await client.query(
          `UPDATE products
              SET stock = stock - $2,
                  discount_left = CASE WHEN discount_left IS NULL THEN NULL
                                       ELSE GREATEST(discount_left - $3, 0) END,
                  updated_at = now()
            WHERE id = $1 RETURNING *`,
          [p.id, qty, discActive ? qty : 0],
        );
        changedProducts.push(upd.rows[0]);
        lineRows.push({ p, qty, unitPrice, unitCost, lineTotal });
      }

      total = Number(total.toFixed(2));
      costTotal = Number(costTotal.toFixed(2));

      // Разбивка оплаты. Картой покрывается заданная часть, остальное —
      // наличными. Для чистого 'card' карта = вся сумма, для 'cash' — 0.
      let cardAmount = 0;
      if (payment_method === 'card') cardAmount = total;
      else if (payment_method === 'mixed') {
        cardAmount = Math.min(Math.max(Number(card_amount) || 0, 0), total);
      }
      const cashAmount = Number((total - cardAmount).toFixed(2));

      // Сдача считается только от наличной части. cash_received — сколько
      // покупатель дал наличными; если не передано, считаем «под расчёт».
      const cashReceivedNum =
        cashAmount > 0 && cash_received != null ? Number(cash_received) : cashAmount;
      const change =
        cashAmount > 0 ? Number((cashReceivedNum - cashAmount).toFixed(2)) : null;

      const saleRow = (
        await client.query(
          `INSERT INTO sales
             (client_id, total, cost_total, payment_method, cash_amount, card_amount,
              cash_received, change_given, user_id, shift_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            client_id ?? null,
            total,
            costTotal,
            payment_method,
            cashAmount,
            cardAmount,
            cashAmount > 0 ? cashReceivedNum : null,
            change,
            user_id ?? null,
            shift.id,
          ],
        )
      ).rows[0];

      for (const l of lineRows) {
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, barcode, name, qty, unit_price, unit_cost, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [saleRow.id, l.p.id, l.p.barcode ?? '', l.p.name, l.qty, l.unitPrice, l.unitCost, l.lineTotal],
        );
      }

      await writeLog(
        {
          type: 'sale',
          entity: 'sale',
          entityId: saleRow.id,
          userId: user_id ?? null,
          details: {
            total,
            margin: Number((total - costTotal).toFixed(2)),
            payment_method,
            items: lineRows.length,
          },
        },
        client,
      );

      return { sale: saleRow, changedProducts };
    });

    // Чек доехал в уже закрытую смену — пересчитываем её сверку и отмечаем
    // это в журнале, чтобы владелец видел, откуда изменилось расхождение.
    if (lateToClosedShift) {
      const updated = await recomputeClosedShift(shift.id);
      await writeLog({
        type: 'late_sale',
        entity: 'shift',
        entityId: shift.id,
        userId: user_id,
        details: { sale_id: result.sale.id, total: result.sale.total, new_difference: updated?.difference },
      });
      if (updated) broadcast('shift', updated);
    }

    result.changedProducts.forEach((p) => broadcast('product_upsert', p, 'all'));
    broadcast('sale', result.sale);
    res.status(201).json({ sale: saleFor(req, result.sale) });
  } catch (err: any) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    if (err?.status === 409) return res.status(409).json({ error: err.message });
    console.error('Ошибка продажи:', err);
    res.status(500).json({ error: 'internal' });
  }
});
