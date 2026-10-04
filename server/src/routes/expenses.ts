import { Router } from 'express';
import { query } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { requireOwner } from '../lib/auth.js';
import { getOpenShift, computeExpected, recomputeClosedShift } from './shifts.js';

export const expensesRouter = Router();

// Расходы точки: деньги уходят из кассы на операционные нужды. Кассир вносит
// расход, но в силу он вступает только после «добро» владельца (status=approved)
// — тогда он уменьшает ожидаемую кассу. Владелец вносит сразу одобренным.

function normKind(v: any): 'cash' | 'wallet' {
  return v === 'wallet' ? 'wallet' : 'cash';
}

// Проверка: хватает ли в кассе на расход (по соответствующей кассе).
async function enoughInTill(shift: any, kind: 'cash' | 'wallet', amount: number): Promise<{ ok: boolean; avail: number }> {
  const exp = await computeExpected(shift);
  const avail = kind === 'wallet' ? exp.wallet : exp.cash;
  return { ok: amount <= avail + 1e-9, avail };
}

// Записать расход. Владелец — сразу одобрен. Кассир — на подтверждение.
expensesRouter.post('/', async (req, res) => {
  const amount = Number(req.body?.amount);
  const kind = normKind(req.body?.kind);
  const category = String(req.body?.category ?? '').trim();
  const note = String(req.body?.note ?? '').trim() || null;

  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма расхода должна быть больше нуля' });
  if (!category) return res.status(400).json({ error: 'Укажите категорию расхода' });

  const shift = await getOpenShift(req.user!.id);
  if (!shift) return res.status(409).json({ error: 'no_shift', message: 'Нет открытой смены' });

  const isOwner = req.user!.role === 'owner';

  if (isOwner) {
    const { ok, avail } = await enoughInTill(shift, kind, amount);
    if (!ok) {
      const label = kind === 'wallet' ? 'на кошельках' : 'наличными';
      return res.status(400).json({ error: `В кассе ${label} только ${avail.toFixed(2)} — на расход ${amount.toFixed(2)} не хватает` });
    }
    const row = (
      await query(
        `INSERT INTO expenses (shift_id, user_id, kind, amount, category, note, status, approved_by, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,'approved',$2, now()) RETURNING *`,
        [shift.id, req.user!.id, kind, amount, category, note],
      )
    )[0];
    await writeLog({
      type: 'expense', entity: 'expense', entityId: row.id, userId: req.user!.id,
      details: { amount, kind, category, note },
    });
    broadcast('shift', shift);
    return res.status(201).json({ expense: row });
  }

  // Кассир — создаём на подтверждение.
  const row = (
    await query(
      `INSERT INTO expenses (shift_id, user_id, kind, amount, category, note, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [shift.id, req.user!.id, kind, amount, category, note],
    )
  )[0];
  await writeLog({
    type: 'expense_request', entity: 'expense', entityId: row.id, userId: req.user!.id,
    details: { amount, kind, category, note },
  });
  broadcast('expense_request', { id: row.id });
  return res.status(202).json({
    pending: true,
    request: row,
    message: `Расход «${category}» на ${amount} отправлен владельцу на подтверждение.`,
  });
});

// Текущие расходы открытой смены (для показа на экране смены).
expensesRouter.get('/current', async (req, res) => {
  const shift = await getOpenShift(req.user!.id);
  if (!shift) return res.json([]);
  const rows = await query(
    `SELECT * FROM expenses WHERE shift_id = $1 AND status IN ('pending','approved')
      ORDER BY created_at DESC`,
    [shift.id],
  );
  res.json(rows);
});

// Кассир: статус своего последнего запроса на расход (экран ожидания).
expensesRouter.get('/my-request', async (req, res) => {
  const rows = await query(
    `SELECT * FROM expenses
      WHERE user_id = $1 AND (status = 'pending' OR resolved_at > now() - interval '10 minutes')
      ORDER BY created_at DESC LIMIT 1`,
    [req.user!.id],
  );
  res.json({ request: rows[0] ?? null });
});

// Кассир: отменить свой запрос.
expensesRouter.post('/requests/:id/cancel', async (req, res) => {
  const rows = await query(
    `UPDATE expenses SET status='cancelled', resolved_at=now()
      WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *`,
    [req.params.id, req.user!.id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  broadcast('expense_request', { id: rows[0].id });
  res.json({ ok: true });
});

// Владелец: запросы на расход, ожидающие подтверждения.
expensesRouter.get('/requests', requireOwner, async (_req, res) => {
  const rows = await query(
    `SELECT e.*, u.username, u.full_name
       FROM expenses e JOIN users u ON u.id = e.user_id
      WHERE e.status = 'pending' ORDER BY e.created_at`,
  );
  res.json(rows);
});

// Владелец: одобрить расход — тогда он уменьшает кассу.
expensesRouter.post('/requests/:id/approve', requireOwner, async (req, res) => {
  const rows = await query(`SELECT * FROM expenses WHERE id=$1`, [req.params.id]);
  const e = rows[0];
  if (!e) return res.status(404).json({ error: 'not_found' });
  if (e.status !== 'pending') return res.status(409).json({ error: 'already_resolved', status: e.status });

  const shiftRows = await query(`SELECT * FROM shifts WHERE id=$1`, [e.shift_id]);
  const shift = shiftRows[0];
  if (!shift) return res.status(409).json({ error: 'no_shift', message: 'Смена расхода не найдена.' });

  const { ok, avail } = await enoughInTill(shift, e.kind, Number(e.amount));
  if (!ok) {
    const label = e.kind === 'wallet' ? 'на кошельках' : 'наличными';
    return res.status(400).json({ error: `В кассе ${label} только ${avail.toFixed(2)} — на расход ${Number(e.amount).toFixed(2)} не хватает` });
  }

  const upd = (
    await query(
      `UPDATE expenses SET status='approved', approved_by=$2, resolved_at=now() WHERE id=$1 RETURNING *`,
      [e.id, req.user!.id],
    )
  )[0];
  await writeLog({
    type: 'expense', entity: 'expense', entityId: e.id, userId: e.user_id,
    details: { amount: Number(e.amount), kind: e.kind, category: e.category, note: e.note, approved_by: { id: req.user!.id, username: req.user!.username } },
  });
  // Если смена уже закрыта — пересчитываем её расхождение.
  if (shift.status === 'closed') {
    const rc = await recomputeClosedShift(shift.id);
    if (rc) broadcast('shift', rc);
  } else {
    broadcast('shift', shift);
  }
  broadcast('expense_request', { id: e.id });
  res.json({ ok: true, expense: upd });
});

// Владелец: отклонить запрос на расход.
expensesRouter.post('/requests/:id/reject', requireOwner, async (req, res) => {
  const rows = await query(
    `UPDATE expenses SET status='rejected', approved_by=$2, resolved_at=now()
      WHERE id=$1 AND status='pending' RETURNING *`,
    [req.params.id, req.user!.id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found_or_resolved' });
  await writeLog({
    type: 'expense_rejected', entity: 'expense', entityId: rows[0].id, userId: req.user!.id,
    details: { amount: Number(rows[0].amount), category: rows[0].category, cashier_id: rows[0].user_id },
  });
  broadcast('expense_request', { id: rows[0].id });
  res.json({ ok: true });
});
