import { Router } from 'express';
import { query } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { requireOwner } from '../lib/auth.js';

export const shiftsRouter = Router();

// Открытая смена пользователя (или null).
export async function getOpenShift(userId: string) {
  const rows = await query(`SELECT * FROM shifts WHERE user_id = $1 AND status = 'open'`, [userId]);
  return rows[0] ?? null;
}

// Пересчёт итогов уже закрытой смены — если в неё «доехал» отложенный чек
// после закрытия. Иначе сверка кассы осталась бы неверной.
export async function recomputeClosedShift(shiftId: string) {
  const rows = await query(`SELECT * FROM shifts WHERE id = $1`, [shiftId]);
  const shift = rows[0];
  if (!shift || shift.status !== 'closed') return null;

  const expected = await computeExpected(shift);
  const counted = Number(shift.counted_cash ?? 0);
  const difference = Number((counted - expected).toFixed(2));

  const upd = await query(
    `UPDATE shifts SET expected_cash = $2, difference = $3 WHERE id = $1 RETURNING *`,
    [shiftId, expected, difference],
  );
  return upd[0];
}

// Сколько наличных должно быть в кассе по чекам этой смены.
async function computeExpected(shift: any): Promise<number> {
  const cashSales = (
    await query<{ sum: number }>(
      `SELECT COALESCE(SUM(total),0) AS sum FROM sales WHERE shift_id = $1 AND payment_method = 'cash'`,
      [shift.id],
    )
  )[0].sum;
  const refunds = (
    await query<{ sum: number }>(`SELECT COALESCE(SUM(total),0) AS sum FROM returns WHERE shift_id = $1`, [shift.id])
  )[0].sum;
  return Number((Number(shift.opening_cash) + Number(cashSales) - Number(refunds)).toFixed(2));
}

// Текущая смена + промежуточный расчёт «ожидается в кассе».
shiftsRouter.get('/current', async (req, res) => {
  const shift = await getOpenShift(req.user!.id);
  if (!shift) return res.json({ shift: null });
  const expected = await computeExpected(shift);
  const stats = (
    await query(
      `SELECT
         (SELECT COUNT(*) FROM sales WHERE shift_id = $1) AS sales_count,
         (SELECT COALESCE(SUM(total),0) FROM sales WHERE shift_id = $1 AND payment_method = 'cash') AS cash_sales,
         (SELECT COALESCE(SUM(total),0) FROM sales WHERE shift_id = $1 AND payment_method = 'card') AS card_sales,
         (SELECT COALESCE(SUM(total),0) FROM returns WHERE shift_id = $1) AS refunds`,
      [shift.id],
    )
  )[0];
  res.json({ shift, expected, stats });
});

// Открыть смену.
shiftsRouter.post('/open', async (req, res) => {
  const opening = Number(req.body?.opening_cash ?? 0);
  const existing = await getOpenShift(req.user!.id);
  if (existing) return res.status(409).json({ error: 'already_open', shift: existing });
  try {
    const shift = (
      await query(
        `INSERT INTO shifts (user_id, opening_cash) VALUES ($1, $2) RETURNING *`,
        [req.user!.id, opening],
      )
    )[0];
    await writeLog({ type: 'shift_open', entity: 'shift', entityId: shift.id, userId: req.user!.id, details: { opening_cash: opening } });
    broadcast('shift', shift);
    res.status(201).json({ shift });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'already_open' });
    throw err;
  }
});

// Закрыть смену: считаем ожидаемое, сравниваем с фактически сданным.
// Владелец может закрыть чужую смену: кассир мог уйти домой, не закрыв её (п.26).
shiftsRouter.post('/close', async (req, res) => {
  const counted = Number(req.body?.counted_cash ?? 0);
  const targetUserId = req.body?.user_id;

  let shift: any;
  if (targetUserId && targetUserId !== req.user!.id) {
    if (req.user!.role !== 'owner') return res.status(403).json({ error: 'owner_only' });
    shift = await getOpenShift(targetUserId);
  } else {
    shift = await getOpenShift(req.user!.id);
  }
  if (!shift) return res.status(409).json({ error: 'no_open_shift' });

  const expected = await computeExpected(shift);
  const difference = Number((counted - expected).toFixed(2));

  const closed = (
    await query(
      `UPDATE shifts
          SET status='closed', closed_at=now(), expected_cash=$2, counted_cash=$3, difference=$4
        WHERE id=$1
        RETURNING *`,
      [shift.id, expected, counted, difference],
    )
  )[0];

  await writeLog({
    type: 'shift_close', entity: 'shift', entityId: shift.id, userId: req.user!.id,
    details: {
      expected, counted, difference,
      // Видно, если смену закрыл не тот, кто её открывал.
      closed_by_owner: shift.user_id !== req.user!.id || undefined,
    },
  });
  // Расхождение — отдельным событием (владелец должен видеть).
  if (difference !== 0) {
    await writeLog({
      type: 'cash_discrepancy', entity: 'shift', entityId: shift.id, userId: req.user!.id,
      details: { expected, counted, difference },
    });
  }
  broadcast('shift', closed);
  res.json({ shift: closed });
});

// Открытые смены (владельцу) — чтобы закрыть за ушедшего кассира.
shiftsRouter.get('/open', requireOwner, async (_req, res) => {
  const rows = await query(
    `SELECT s.*, u.username, u.full_name
       FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'open' ORDER BY s.opened_at`,
  );
  res.json(rows);
});

// Список смен. Владелец видит все, кассир — только свои (п.4 ТЗ).
shiftsRouter.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const isOwner = req.user!.role === 'owner';
  const rows = await query(
    `SELECT s.*, u.username, u.full_name
       FROM shifts s LEFT JOIN users u ON u.id = s.user_id
      ${isOwner ? '' : 'WHERE s.user_id = $2'}
      ORDER BY s.opened_at DESC
      LIMIT $1`,
    isOwner ? [limit] : [limit, req.user!.id],
  );
  res.json(rows);
});
