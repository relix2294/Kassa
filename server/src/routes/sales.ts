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

// Провести продажу (чек).
// Тело: { client_id, items:[{barcode, qty}], payment_method, cash_received?, user_id }
salesRouter.post('/', async (req, res) => {
  const { client_id, items, payment_method, cash_received, shift_id } = req.body ?? {};
  const user_id = req.user!.id;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Пустой чек' });
  }
  if (payment_method !== 'cash' && payment_method !== 'card') {
    return res.status(400).json({ error: 'payment_method: cash | card' });
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

        const found = await client.query(`SELECT * FROM products WHERE barcode = $1 FOR UPDATE`, [
          item.barcode,
        ]);
        if (found.rows.length === 0) {
          throw { status: 400, message: `Товар не найден: ${item.barcode}` };
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

        const unitPrice = Number(p.sale_price);
        const unitCost = Number(p.cost_price);
        const lineTotal = Number((unitPrice * qty).toFixed(2));
        total += lineTotal;
        costTotal += Number((unitCost * qty).toFixed(2));

        const upd = await client.query(
          `UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1 RETURNING *`,
          [p.id, qty],
        );
        changedProducts.push(upd.rows[0]);
        lineRows.push({ p, qty, unitPrice, unitCost, lineTotal });
      }

      total = Number(total.toFixed(2));
      costTotal = Number(costTotal.toFixed(2));

      const change =
        payment_method === 'cash' && cash_received != null
          ? Number((Number(cash_received) - total).toFixed(2))
          : null;

      const saleRow = (
        await client.query(
          `INSERT INTO sales (client_id, total, cost_total, payment_method, cash_received, change_given, user_id, shift_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            client_id ?? null,
            total,
            costTotal,
            payment_method,
            payment_method === 'cash' ? cash_received ?? null : null,
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
          [saleRow.id, l.p.id, l.p.barcode, l.p.name, l.qty, l.unitPrice, l.unitCost, l.lineTotal],
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
    console.error('Ошибка продажи:', err);
    res.status(500).json({ error: 'internal' });
  }
});
