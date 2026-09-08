import { Router } from 'express';
import { query, withTx } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { getOpenShift, recomputeClosedShift } from './shifts.js';
import { requireOwner } from '../lib/auth.js';

export const returnsRouter = Router();

// Список возвратов с позициями — только владелец.
// Возврат идёт без чека, поэтому это главный контроль: владелец должен
// видеть каждый возврат целиком (кто, что, сколько, почему).
returnsRouter.get('/', requireOwner, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await query(
    `SELECT r.id, r.total, r.reason, r.created_at,
            u.username, u.full_name,
            COALESCE(
              json_agg(
                json_build_object('name', ri.name, 'qty', ri.qty, 'line_total', ri.line_total)
                ORDER BY ri.name
              ) FILTER (WHERE ri.id IS NOT NULL), '[]'
            ) AS items
       FROM returns r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN return_items ri ON ri.return_id = r.id
      GROUP BY r.id, u.username, u.full_name
      ORDER BY r.created_at DESC
      LIMIT $1`,
    [limit],
  );
  res.json(rows);
});

// Возврат/обмен: товар возвращается на склад, деньги выходят из кассы.
// Тело: { client_id, items:[{barcode, qty}], reason?, sale_id?, user_id }
returnsRouter.post('/', async (req, res) => {
  const { client_id, items, reason, sale_id } = req.body ?? {};
  const user_id = req.user!.id;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Пустой возврат' });
  }

  // Возврат идёт без чека, поэтому причина обязательна: это единственный
  // след, по которому владелец потом разберёт, что произошло.
  if (!reason || String(reason).trim().length < 3) {
    return res.status(400).json({ error: 'Укажите причину возврата' });
  }

  if (client_id) {
    const existing = await query(`SELECT * FROM returns WHERE client_id = $1`, [client_id]);
    if (existing.length > 0) return res.status(200).json({ ret: existing[0], duplicate: true });
  }

  // Возврат — тоже движение денег: привязываем к своей смене, даже если она
  // уже закрыта (возврат мог быть отложен обрывом сети).
  const { shift_id } = req.body ?? {};
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
      const changedProducts: any[] = [];
      const lineRows: any[] = [];

      for (const item of items) {
        const qty = Number(item.qty);
        if (!(qty > 0)) throw { status: 400, message: 'qty > 0' };

        const found = await client.query(`SELECT * FROM products WHERE barcode = $1 FOR UPDATE`, [
          item.barcode,
        ]);
        if (found.rows.length === 0) throw { status: 400, message: `Товар не найден: ${item.barcode}` };
        const p = found.rows[0];

        // Цену возврата берём из чека, если передана, иначе текущую цену продажи.
        const unitPrice = item.unit_price != null ? Number(item.unit_price) : Number(p.sale_price);
        const lineTotal = Number((unitPrice * qty).toFixed(2));
        total += lineTotal;

        const upd = await client.query(
          `UPDATE products SET stock = stock + $2, updated_at = now() WHERE id = $1 RETURNING *`,
          [p.id, qty],
        );
        changedProducts.push(upd.rows[0]);
        lineRows.push({ p, qty, unitPrice, lineTotal });
      }

      total = Number(total.toFixed(2));

      const retRow = (
        await client.query(
          `INSERT INTO returns (client_id, sale_id, total, reason, user_id, shift_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [client_id ?? null, sale_id ?? null, total, reason ?? null, user_id ?? null, shift.id],
        )
      ).rows[0];

      for (const l of lineRows) {
        await client.query(
          `INSERT INTO return_items (return_id, product_id, barcode, name, qty, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [retRow.id, l.p.id, l.p.barcode, l.p.name, l.qty, l.unitPrice, l.lineTotal],
        );
      }

      await writeLog(
        {
          type: 'return',
          entity: 'return',
          entityId: retRow.id,
          userId: user_id ?? null,
          details: { total, items: lineRows.length, reason: reason ?? null },
        },
        client,
      );

      return { ret: retRow, changedProducts };
    });

    if (lateToClosedShift) {
      const updated = await recomputeClosedShift(shift.id);
      await writeLog({
        type: 'late_return', entity: 'shift', entityId: shift.id, userId: user_id,
        details: { return_id: result.ret.id, total: result.ret.total, new_difference: updated?.difference },
      });
      if (updated) broadcast('shift', updated);
    }

    result.changedProducts.forEach((p) => broadcast('product_upsert', p, 'all'));
    broadcast('return', result.ret);
    res.status(201).json({ ret: result.ret });
  } catch (err: any) {
    if (err?.status === 400) return res.status(400).json({ error: err.message });
    console.error('Ошибка возврата:', err);
    res.status(500).json({ error: 'internal' });
  }
});
