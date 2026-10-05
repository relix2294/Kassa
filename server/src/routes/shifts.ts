import { Router } from 'express';
import { query } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { requireOwner } from '../lib/auth.js';

export const shiftsRouter = Router();

// Незакрытый запрос кассира на действие со сменой (открытие/закрытие с
// расхождением). Ждёт «добро» владельца из его кабинета.
async function getPendingRequest(userId: string, kind?: 'open' | 'close') {
  const rows = await query(
    `SELECT * FROM shift_requests
      WHERE user_id = $1 AND status = 'pending' ${kind ? 'AND kind = $2' : ''}
      ORDER BY created_at DESC LIMIT 1`,
    kind ? [userId, kind] : [userId],
  );
  return rows[0] ?? null;
}

// Открытая смена пользователя (или null).
export async function getOpenShift(userId: string) {
  const rows = await query(`SELECT * FROM shifts WHERE user_id = $1 AND status = 'open'`, [userId]);
  return rows[0] ?? null;
}

// Любая открытая смена на точке (касса одна — активная смена одна).
export async function getAnyOpenShift() {
  const rows = await query(
    `SELECT s.*, u.username, u.full_name FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.status = 'open' ORDER BY s.opened_at LIMIT 1`,
  );
  return rows[0] ?? null;
}

// Остаток от прошлой закрытой смены — ожидаемый старт следующей. Деньги
// физически остаются: и наличные в ящике, и баланс на кошельках (безнал).
async function getLastClosing(): Promise<{ cash: number; wallet: number }> {
  const rows = await query(
    `SELECT counted_cash, counted_wallet FROM shifts
      WHERE status = 'closed' AND counted_cash IS NOT NULL
      ORDER BY closed_at DESC LIMIT 1`,
  );
  return {
    cash: rows.length ? Number(rows[0].counted_cash) : 0,
    wallet: rows.length ? Number(rows[0].counted_wallet ?? 0) : 0,
  };
}

// Сколько должно быть по чекам этой смены — отдельно наличные и безнал (кошельки).
// Учитываем изъятия И одобренные расходы (деньги ушли из кассы на нужды точки).
export async function computeExpected(shift: any): Promise<{ cash: number; wallet: number }> {
  const s = (
    await query<{ cash_sales: number; card_sales: number; refunds: number }>(
      `SELECT
         (SELECT COALESCE(SUM(COALESCE(cash_amount, total)),0) FROM sales WHERE shift_id = $1) AS cash_sales,
         (SELECT COALESCE(SUM(COALESCE(card_amount, 0)),0) FROM sales WHERE shift_id = $1) AS card_sales,
         (SELECT COALESCE(SUM(total),0) FROM returns WHERE shift_id = $1) AS refunds`,
      [shift.id],
    )
  )[0];
  const wd = await query<{ kind: string; sum: number }>(
    `SELECT kind, COALESCE(SUM(amount),0) AS sum FROM cash_withdrawals WHERE shift_id = $1 GROUP BY kind`,
    [shift.id],
  );
  const cashWd = Number(wd.find((r) => r.kind === 'cash')?.sum ?? 0);
  const walletWd = Number(wd.find((r) => r.kind === 'wallet')?.sum ?? 0);

  // Одобренные расходы — тоже вышли из кассы.
  const ex = await query<{ kind: string; sum: number }>(
    `SELECT kind, COALESCE(SUM(amount),0) AS sum FROM expenses
      WHERE shift_id = $1 AND status = 'approved' GROUP BY kind`,
    [shift.id],
  );
  const cashEx = Number(ex.find((r) => r.kind === 'cash')?.sum ?? 0);
  const walletEx = Number(ex.find((r) => r.kind === 'wallet')?.sum ?? 0);

  // Оплаты поставщикам из кассы — деньги физически ушли из ящика (для сверки).
  // В прибыль как расход НЕ идут: себестоимость уже учтена в марже при продаже.
  const sp = await query<{ source: string; sum: number }>(
    `SELECT source, COALESCE(SUM(amount),0) AS sum FROM supplier_payments
      WHERE shift_id = $1 AND source IN ('cash','wallet') GROUP BY source`,
    [shift.id],
  );
  const cashSp = Number(sp.find((r) => r.source === 'cash')?.sum ?? 0);
  const walletSp = Number(sp.find((r) => r.source === 'wallet')?.sum ?? 0);

  // Возврат отдаётся наличными из кассы — уменьшает наличные.
  const cash = Number((Number(shift.opening_cash) + Number(s.cash_sales) - Number(s.refunds) - cashWd - cashEx - cashSp).toFixed(2));
  const wallet = Number((Number(shift.opening_wallet ?? 0) + Number(s.card_sales) - walletWd - walletEx - walletSp).toFixed(2));
  return { cash, wallet };
}

// Пересчёт итогов уже закрытой смены — если в неё «доехал» отложенный чек.
export async function recomputeClosedShift(shiftId: string) {
  const rows = await query(`SELECT * FROM shifts WHERE id = $1`, [shiftId]);
  const shift = rows[0];
  if (!shift || shift.status !== 'closed') return null;
  const exp = await computeExpected(shift);
  const cashDiff = Number((Number(shift.counted_cash ?? 0) - exp.cash).toFixed(2));
  const walletDiff = Number((Number(shift.counted_wallet ?? 0) - exp.wallet).toFixed(2));
  const upd = await query(
    `UPDATE shifts SET expected_cash = $2, difference = $3, expected_wallet = $4, wallet_difference = $5
      WHERE id = $1 RETURNING *`,
    [shiftId, exp.cash, cashDiff, exp.wallet, walletDiff],
  );
  return upd[0];
}

// Текущая смена + промежуточный расчёт «ожидается» (наличные и безнал).
shiftsRouter.get('/current', async (req, res) => {
  const shift = await getOpenShift(req.user!.id);
  if (!shift) return res.json({ shift: null });
  const exp = await computeExpected(shift);
  const stats = (
    await query(
      `SELECT
         (SELECT COUNT(*) FROM sales WHERE shift_id = $1) AS sales_count,
         (SELECT COALESCE(SUM(COALESCE(cash_amount, total)),0) FROM sales WHERE shift_id = $1) AS cash_sales,
         (SELECT COALESCE(SUM(COALESCE(card_amount, 0)),0) FROM sales WHERE shift_id = $1) AS card_sales,
         (SELECT COALESCE(SUM(total),0) FROM returns WHERE shift_id = $1) AS refunds,
         (SELECT COALESCE(SUM(amount),0) FROM cash_withdrawals WHERE shift_id = $1 AND kind='cash') AS withdrawn,
         (SELECT COALESCE(SUM(amount),0) FROM cash_withdrawals WHERE shift_id = $1 AND kind='wallet') AS wallet_withdrawn,
         (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE shift_id = $1 AND status='approved' AND kind='cash') AS spent_cash,
         (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE shift_id = $1 AND status='approved' AND kind='wallet') AS spent_wallet,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments WHERE shift_id = $1 AND source='cash') AS supplier_cash,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments WHERE shift_id = $1 AND source='wallet') AS supplier_wallet`,
      [shift.id],
    )
  )[0];
  res.json({ shift, expected_cash: exp.cash, expected_wallet: exp.wallet, stats });
});

// Остаток на старте смены (нал + безнал) для приёма кассы.
shiftsRouter.get('/expected-opening', async (_req, res) => {
  res.json(await getLastClosing());
});

// Открыть смену. Принимаем ОБЕ кассы: наличные и безнал (баланс кошельков).
shiftsRouter.post('/open', async (req, res) => {
  const openingCash = Number(req.body?.opening_cash ?? 0);
  const openingWallet = Number(req.body?.opening_wallet ?? 0);

  // Касса одна — вторую смену открыть нельзя, пока не закрыта текущая.
  const anyOpen = await getAnyOpenShift();
  if (anyOpen) {
    return res.status(409).json({
      error: 'shift_already_open',
      message: `Смена уже открыта (${anyOpen.full_name || anyOpen.username}). Сначала закройте её.`,
      shift: anyOpen,
    });
  }

  const prev = await getLastClosing();
  const cashDiff0 = Number((openingCash - prev.cash).toFixed(2));
  const walletDiff0 = Number((openingWallet - prev.wallet).toFixed(2));
  const mismatch = cashDiff0 !== 0 || walletDiff0 !== 0;

  // Железобетонное правило: принять кассу с расхождением может только владелец.
  // Кассир сам открыть не может — создаётся запрос, а владелец даёт «добро» из
  // своего кабинета (он может быть не в магазине). Смена откроется на кассира.
  if (mismatch && req.user!.role !== 'owner') {
    const existing = await getPendingRequest(req.user!.id, 'open');
    const request = existing ?? (
      await query(
        `INSERT INTO shift_requests
           (kind, user_id, counted_cash, counted_wallet, expected_cash, expected_wallet, cash_diff, wallet_diff)
         VALUES ('open',$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user!.id, openingCash, openingWallet, prev.cash, prev.wallet, cashDiff0, walletDiff0],
      )
    )[0];
    if (!existing) {
      await writeLog({
        type: 'shift_request', entity: 'shift_request', entityId: request.id, userId: req.user!.id,
        details: { kind: 'open', counted_cash: openingCash, counted_wallet: openingWallet, expected_cash: prev.cash, expected_wallet: prev.wallet, cash_diff: cashDiff0, wallet_diff: walletDiff0 },
      });
      broadcast('shift_request', { id: request.id });
    }
    return res.status(202).json({
      pending: true,
      request,
      message:
        `Не сходится с остатком прошлой смены. Наличные: ожидалось ${prev.cash}, ввели ${openingCash}. ` +
        `Безнал: ожидалось ${prev.wallet}, ввели ${openingWallet}. ` +
        `Открыть кассу может только владелец. Запрос отправлен — позвоните владельцу, он подтвердит из своего кабинета.`,
      expected: prev,
    });
  }

  try {
    const shift = await createOpenShift(req.user!.id, openingCash, openingWallet, prev, null);
    res.status(201).json({ shift, expected: prev, handover: { cash: cashDiff0, wallet: walletDiff0 } });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'already_open' });
    throw err;
  }
});

// Собственно создание открытой смены + журнал. approvedBy — владелец, если
// открытие было с расхождением и он его подтвердил.
async function createOpenShift(
  userId: string,
  openingCash: number,
  openingWallet: number,
  prev: { cash: number; wallet: number },
  approvedBy: { id: string; username: string } | null,
) {
  const shift = (
    await query(
      `INSERT INTO shifts (user_id, opening_cash, opening_expected, opening_wallet, opening_wallet_expected)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, openingCash, prev.cash, openingWallet, prev.wallet],
    )
  )[0];
  await writeLog({
    type: 'shift_open', entity: 'shift', entityId: shift.id, userId,
    details: {
      opening_cash: openingCash, opening_wallet: openingWallet,
      expected_cash: prev.cash, expected_wallet: prev.wallet,
      approved_by: approvedBy ?? undefined,
    },
  });
  const cashDiff = Number((openingCash - prev.cash).toFixed(2));
  const walletDiff = Number((openingWallet - prev.wallet).toFixed(2));
  if (cashDiff !== 0 || walletDiff !== 0) {
    await writeLog({
      type: 'handover_discrepancy', entity: 'shift', entityId: shift.id, userId,
      details: {
        cash: { expected: prev.cash, counted: openingCash, difference: cashDiff },
        wallet: { expected: prev.wallet, counted: openingWallet, difference: walletDiff },
        approved_by: approvedBy ?? undefined,
      },
    });
  }
  broadcast('shift', shift);
  return shift;
}

// Изъятие из кассы (инкассация) — владелец. kind: 'cash' (наличные) | 'wallet' (безнал).
shiftsRouter.post('/withdraw', requireOwner, async (req, res) => {
  const amount = Number(req.body?.amount);
  const kind = req.body?.kind === 'wallet' ? 'wallet' : 'cash';
  const note = String(req.body?.note ?? '').trim() || null;
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма изъятия должна быть больше нуля' });

  const shift = await getAnyOpenShift();
  if (!shift) return res.status(409).json({ error: 'no_open_shift', message: 'Нет открытой смены' });

  const exp = await computeExpected(shift);
  const avail = kind === 'wallet' ? exp.wallet : exp.cash;
  const label = kind === 'wallet' ? 'на кошельках' : 'наличными';
  if (amount > avail + 1e-9) {
    return res.status(400).json({ error: `В кассе ${label} только ${avail.toFixed(2)} — нельзя изъять ${amount.toFixed(2)}` });
  }

  await query(`INSERT INTO cash_withdrawals (shift_id, amount, note, kind, user_id) VALUES ($1,$2,$3,$4,$5)`,
    [shift.id, amount, note, kind, req.user!.id]);
  await writeLog({ type: 'cash_withdraw', entity: 'shift', entityId: shift.id, userId: req.user!.id, details: { amount, kind, note } });
  broadcast('shift', shift);
  res.status(201).json({ ok: true });
});

// Закрыть смену: сверяем ОБЕ кассы — наличные и безнал.
shiftsRouter.post('/close', async (req, res) => {
  const countedCash = Number(req.body?.counted_cash ?? 0);
  const countedWallet = Number(req.body?.counted_wallet ?? 0);
  const targetUserId = req.body?.user_id;

  let shift: any;
  if (targetUserId && targetUserId !== req.user!.id) {
    if (req.user!.role !== 'owner') return res.status(403).json({ error: 'owner_only' });
    shift = await getOpenShift(targetUserId);
  } else {
    shift = await getOpenShift(req.user!.id);
  }
  if (!shift) return res.status(409).json({ error: 'no_open_shift' });

  const exp = await computeExpected(shift);
  const cashDiff = Number((countedCash - exp.cash).toFixed(2));
  const walletDiff = Number((countedWallet - exp.wallet).toFixed(2));

  // Железобетонное правило: закрыть смену с расхождением может только владелец.
  // Кассир сам закрыть не может — создаётся запрос, владелец даёт «добро» из
  // кабинета (может быть не в магазине). Смена закроется под тем же кассиром.
  if ((cashDiff !== 0 || walletDiff !== 0) && req.user!.role !== 'owner') {
    const existing = await getPendingRequest(req.user!.id, 'close');
    const request = existing ?? (
      await query(
        `INSERT INTO shift_requests
           (kind, user_id, shift_id, counted_cash, counted_wallet, expected_cash, expected_wallet, cash_diff, wallet_diff)
         VALUES ('close',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.user!.id, shift.id, countedCash, countedWallet, exp.cash, exp.wallet, cashDiff, walletDiff],
      )
    )[0];
    if (!existing) {
      await writeLog({
        type: 'shift_request', entity: 'shift_request', entityId: request.id, userId: req.user!.id,
        details: { kind: 'close', shift_id: shift.id, counted_cash: countedCash, counted_wallet: countedWallet, expected_cash: exp.cash, expected_wallet: exp.wallet, cash_diff: cashDiff, wallet_diff: walletDiff },
      });
      broadcast('shift_request', { id: request.id });
    }
    return res.status(202).json({
      pending: true,
      request,
      message:
        `Расхождение при закрытии. Наличные: ожидалось ${exp.cash}, посчитали ${countedCash} (${cashDiff > 0 ? '+' : ''}${cashDiff}). ` +
        `Безнал: ожидалось ${exp.wallet}, посчитали ${countedWallet} (${walletDiff > 0 ? '+' : ''}${walletDiff}). ` +
        `Закрыть смену может только владелец. Запрос отправлен — позвоните владельцу, он подтвердит из своего кабинета.`,
      expected_cash: exp.cash,
      expected_wallet: exp.wallet,
    });
  }

  const closed = await closeShiftRow(shift, req.user!.id, countedCash, countedWallet, null);
  res.json({ shift: closed });
});

// Собственно закрытие смены + журнал. approvedBy — владелец, если закрытие было
// с расхождением и он его подтвердил.
async function closeShiftRow(
  shift: any,
  actorId: string,
  countedCash: number,
  countedWallet: number,
  approvedBy: { id: string; username: string } | null,
) {
  const exp = await computeExpected(shift);
  const cashDiff = Number((countedCash - exp.cash).toFixed(2));
  const walletDiff = Number((countedWallet - exp.wallet).toFixed(2));
  const closed = (
    await query(
      `UPDATE shifts
          SET status='closed', closed_at=now(),
              expected_cash=$2, counted_cash=$3, difference=$4,
              expected_wallet=$5, counted_wallet=$6, wallet_difference=$7
        WHERE id=$1 RETURNING *`,
      [shift.id, exp.cash, countedCash, cashDiff, exp.wallet, countedWallet, walletDiff],
    )
  )[0];
  await writeLog({
    type: 'shift_close', entity: 'shift', entityId: shift.id, userId: actorId,
    details: {
      cash: { expected: exp.cash, counted: countedCash, difference: cashDiff },
      wallet: { expected: exp.wallet, counted: countedWallet, difference: walletDiff },
      closed_by_owner: shift.user_id !== actorId || undefined,
      approved_by: approvedBy ?? undefined,
    },
  });
  if (cashDiff !== 0 || walletDiff !== 0) {
    await writeLog({
      type: 'cash_discrepancy', entity: 'shift', entityId: shift.id, userId: actorId,
      details: { cash_difference: cashDiff, wallet_difference: walletDiff, approved_by: approvedBy ?? undefined },
    });
  }
  broadcast('shift', closed);
  return closed;
}

// --- Запросы кассира на кассу с расхождением (подтверждает владелец) ---

// Кассир: статус своего последнего запроса (для экрана ожидания).
// Отдаём pending, а также недавно решённые (approved/rejected) — чтобы касса
// среагировала. Старые (>10 мин) не тянем, чтобы не всплывали заново.
shiftsRouter.get('/my-request', async (req, res) => {
  const rows = await query(
    `SELECT * FROM shift_requests
      WHERE user_id = $1
        AND (status = 'pending' OR resolved_at > now() - interval '10 minutes')
      ORDER BY created_at DESC LIMIT 1`,
    [req.user!.id],
  );
  res.json({ request: rows[0] ?? null });
});

// Кассир: отменить свой запрос (передумал / пересчитает).
shiftsRouter.post('/requests/:id/cancel', async (req, res) => {
  const rows = await query(
    `UPDATE shift_requests SET status='cancelled', resolved_at=now()
      WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *`,
    [req.params.id, req.user!.id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  broadcast('shift_request', { id: rows[0].id });
  res.json({ ok: true });
});

// Владелец: список запросов, ожидающих подтверждения (с именем кассира).
shiftsRouter.get('/requests', requireOwner, async (_req, res) => {
  const rows = await query(
    `SELECT r.*, u.username, u.full_name
       FROM shift_requests r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pending' ORDER BY r.created_at`,
  );
  res.json(rows);
});

// Владелец: дать «добро» — выполнить действие кассира (открыть/закрыть смену).
shiftsRouter.post('/requests/:id/approve', requireOwner, async (req, res) => {
  const reqRows = await query(`SELECT * FROM shift_requests WHERE id=$1`, [req.params.id]);
  const r = reqRows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'already_resolved', status: r.status });

  const approver = { id: req.user!.id, username: req.user!.username };

  if (r.kind === 'open') {
    // Касса одна — если уже открыта смена, открыть нельзя.
    const anyOpen = await getAnyOpenShift();
    if (anyOpen) {
      return res.status(409).json({
        error: 'shift_already_open',
        message: `Смена уже открыта (${anyOpen.full_name || anyOpen.username}).`,
      });
    }
    const prev = await getLastClosing();
    const shift = await createOpenShift(
      r.user_id, Number(r.counted_cash), Number(r.counted_wallet), prev, approver,
    );
    await query(`UPDATE shift_requests SET status='approved', resolved_by=$2, resolved_at=now() WHERE id=$1`,
      [r.id, req.user!.id]);
    broadcast('shift_request', { id: r.id });
    return res.json({ ok: true, kind: 'open', shift });
  }

  // kind === 'close'
  const shift = await query(`SELECT * FROM shifts WHERE id=$1`, [r.shift_id]);
  const s = shift[0];
  if (!s || s.status !== 'open') {
    await query(`UPDATE shift_requests SET status='cancelled', resolved_by=$2, resolved_at=now() WHERE id=$1`,
      [r.id, req.user!.id]);
    return res.status(409).json({ error: 'shift_not_open', message: 'Смена уже закрыта или не найдена.' });
  }
  const closed = await closeShiftRow(s, r.user_id, Number(r.counted_cash), Number(r.counted_wallet), approver);
  await query(`UPDATE shift_requests SET status='approved', resolved_by=$2, resolved_at=now() WHERE id=$1`,
    [r.id, req.user!.id]);
  broadcast('shift_request', { id: r.id });
  res.json({ ok: true, kind: 'close', shift: closed });
});

// Владелец: отклонить запрос — действие не выполняется.
shiftsRouter.post('/requests/:id/reject', requireOwner, async (req, res) => {
  const rows = await query(
    `UPDATE shift_requests SET status='rejected', resolved_by=$2, resolved_at=now()
      WHERE id=$1 AND status='pending' RETURNING *`,
    [req.params.id, req.user!.id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found_or_resolved' });
  await writeLog({
    type: 'shift_request_rejected', entity: 'shift_request', entityId: rows[0].id, userId: req.user!.id,
    details: { kind: rows[0].kind, cashier_id: rows[0].user_id },
  });
  broadcast('shift_request', { id: rows[0].id });
  res.json({ ok: true });
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
