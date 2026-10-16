import { Router } from 'express';
import { query } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { requireOwner } from '../lib/auth.js';
import { getOpenShift, computeExpected, recomputeClosedShift, computeAccountable, tillAvailable, tillShortMessage } from './shifts.js';
import { notifyExpense, notifyRequest } from '../lib/telegram.js';

export const expensesRouter = Router();

// Расходы точки: деньги уходят из кассы на операционные нужды. Кассир вносит
// расход, но в силу он вступает только после «добро» владельца (status=approved)
// — тогда он уменьшает ожидаемую кассу. Владелец вносит сразу одобренным.

function normKind(v: any): 'cash' | 'wallet' {
  return v === 'wallet' ? 'wallet' : 'cash';
}

// Проверка для одобрения запроса кассира: хватает ли в кассе его смены.
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
  const isOwner = req.user!.role === 'owner';

  // Кассир может записать расход только в свою открытую смену.
  if (!isOwner && !shift) return res.status(409).json({ error: 'no_shift', message: 'Нет открытой смены' });

  // Откуда деньги владелец выбирает ЯВНО: «из кассы» или «с рук (подотчёт)».
  // Значения по умолчанию нет — иначе по привычке жмут «из кассы», и расход
  // списывается не оттуда, откуда реально взяли деньги. Кассир платит только из
  // кассы (подотчёт — у того, кто изымал, а изъятие — право владельца).
  let paidFrom: 'register' | 'hand' = 'register';
  if (isOwner) {
    const pf = req.body?.paid_from;
    if (pf !== 'register' && pf !== 'hand') {
      return res.status(400).json({ error: 'Выберите, откуда деньги: из кассы или с рук (подотчёт)' });
    }
    paidFrom = pf;
  }

  if (isOwner) {
    // К какой смене привязать расход «из кассы»: к ОТКРЫТОЙ смене (чья угодно —
    // касса одна), а если смена закрыта — к закрытому ящику (без смены).
    let tillShift: any = null;
    if (paidFrom === 'hand') {
      // Расход из подотчёта: кассу не трогает, но у человека должно хватать
      // денег «на руках» (иначе подотчёт ушёл бы в минус — это ошибка учёта).
      const acc = await computeAccountable(req.user!.id);
      if (amount > acc.on_hand + 1e-9) {
        return res.status(400).json({ error: `На руках только ${acc.on_hand.toFixed(2)} — на расход ${amount.toFixed(2)} не хватает. Сначала изымите деньги из кассы.` });
      }
    } else {
      // Расход из кассы: деньги физически уходят из ящика — их там должно хватать.
      const { avail, shift: open } = await tillAvailable(kind);
      if (amount > avail + 1e-9) {
        return res.status(400).json({ error: tillShortMessage(kind, avail, amount, open, 'на расход') });
      }
      tillShift = open;
    }
    const row = (
      await query(
        `INSERT INTO expenses (shift_id, user_id, kind, amount, category, note, status, approved_by, resolved_at, paid_from)
         VALUES ($1,$2,$3,$4,$5,$6,'approved',$2, now(), $7) RETURNING *`,
        // Расход из подотчёта к смене не привязываем — он не часть сверки кассы.
        [paidFrom === 'hand' ? null : (tillShift?.id ?? null), req.user!.id, kind, amount, category, note, paidFrom],
      )
    )[0];
    await writeLog({
      type: 'expense', entity: 'expense', entityId: row.id, userId: req.user!.id,
      details: { amount, kind, category, note, paid_from: paidFrom, closed_till: (paidFrom === 'register' && !tillShift) || undefined },
    });
    if (tillShift && paidFrom === 'register') broadcast('shift', tillShift);
    else broadcast('data_updated', { kind: 'expense' });
    void notifyExpense({ userId: req.user!.id, amount, category, paidFrom });
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
  void notifyRequest({ userId: req.user!.id, what: `расход «${category}» на ${amount}` });
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
  void notifyExpense({ userId: e.user_id, amount: Number(e.amount), category: e.category, paidFrom: e.paid_from, approved: true });
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
