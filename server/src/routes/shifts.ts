import { Router } from 'express';
import { query } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { requireOwner } from '../lib/auth.js';
import { notifyDeposit, notifyShiftOpen, sendShiftCloseReport, notifyWithdraw, notifyRequest } from '../lib/telegram.js';

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

// Остаток от прошлой закрытой смены — то, что пересчитали при закрытии.
export async function getLastClosing(): Promise<{ cash: number; wallet: number; closed_at: string | null }> {
  const rows = await query(
    `SELECT counted_cash, counted_wallet, closed_at FROM shifts
      WHERE status = 'closed' AND counted_cash IS NOT NULL
      ORDER BY closed_at DESC LIMIT 1`,
  );
  return {
    cash: rows.length ? Number(rows[0].counted_cash) : 0,
    wallet: rows.length ? Number(rows[0].counted_wallet ?? 0) : 0,
    closed_at: rows.length ? rows[0].closed_at : null,
  };
}

// Касса, когда смена ЗАКРЫТА: ящик никуда не делся. В нём то, что пересчитали
// при закрытии, минус всё, что владелец взял из него ПОСЛЕ закрытия: изъятия на
// руки, расходы «из кассы», оплаты поставщикам «из кассы». Такие движения пишутся
// без смены (shift_id пуст) и позже последнего закрытия. Это и есть стартовый
// остаток следующей смены: забрали всё — касса 0, утром принимают 0.
export async function getClosedTill(): Promise<{ cash: number; wallet: number }> {
  const last = await getLastClosing();
  const after = last.closed_at ? `AND created_at > $1` : '';
  const params = last.closed_at ? [last.closed_at] : [];
  const r = (
    await query<Record<string, number>>(
      `SELECT
         (SELECT COALESCE(SUM(amount),0) FROM cash_withdrawals
            WHERE shift_id IS NULL AND kind = 'cash' ${after}) AS wd_cash,
         (SELECT COALESCE(SUM(amount),0) FROM cash_withdrawals
            WHERE shift_id IS NULL AND kind = 'wallet' ${after}) AS wd_wallet,
         (SELECT COALESCE(SUM(amount),0) FROM expenses
            WHERE shift_id IS NULL AND status = 'approved' AND paid_from = 'register' AND kind = 'cash' ${after}) AS ex_cash,
         (SELECT COALESCE(SUM(amount),0) FROM expenses
            WHERE shift_id IS NULL AND status = 'approved' AND paid_from = 'register' AND kind = 'wallet' ${after}) AS ex_wallet,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments
            WHERE shift_id IS NULL AND source = 'cash' ${after}) AS sp_cash,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments
            WHERE shift_id IS NULL AND source = 'wallet' ${after}) AS sp_wallet`,
      params,
    )
  )[0];
  return {
    cash: Number((last.cash - Number(r.wd_cash) - Number(r.ex_cash) - Number(r.sp_cash)).toFixed(2)),
    wallet: Number((last.wallet - Number(r.wd_wallet) - Number(r.ex_wallet) - Number(r.sp_wallet)).toFixed(2)),
  };
}

// Сколько сейчас реально в кассе по виду денег и к какой смене писать движение:
// открыта смена (чья угодно — касса одна) → её живой расчёт и её id; закрыта →
// остаток закрытой кассы и без смены. Единое правило для изъятий, расходов и
// оплат поставщикам «из кассы».
export async function tillAvailable(kind: 'cash' | 'wallet'): Promise<{ avail: number; shift: any | null }> {
  const shift = await getAnyOpenShift();
  if (shift) {
    const e = await computeExpected(shift);
    return { avail: kind === 'wallet' ? e.wallet : e.cash, shift };
  }
  const c = await getClosedTill();
  return { avail: kind === 'wallet' ? c.wallet : c.cash, shift: null };
}

// Понятный текст отказа «в кассе не хватает».
export function tillShortMessage(kind: 'cash' | 'wallet', avail: number, amount: number, shift: any | null, what: string): string {
  const label = kind === 'wallet' ? 'на кошельках' : 'наличными';
  if (!shift) {
    return `Смена закрыта — в кассе ${label} ${avail.toFixed(2)}, ${what} ${amount.toFixed(2)} нельзя. ` +
      `Если деньги изъяли на руки — выберите «с рук (подотчёт)».`;
  }
  return `В кассе ${label} только ${avail.toFixed(2)} — ${what} ${amount.toFixed(2)} нельзя`;
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

  // Одобренные расходы «из кассы» — тоже вышли из ящика. Расходы «из подотчёта»
  // (paid_from='hand') кассу не трогают: деньги вышли ещё при изъятии на руки,
  // иначе один расход вычелся бы дважды (из ящика и из подотчёта).
  const ex = await query<{ kind: string; sum: number }>(
    `SELECT kind, COALESCE(SUM(amount),0) AS sum FROM expenses
      WHERE shift_id = $1 AND status = 'approved' AND paid_from = 'register' GROUP BY kind`,
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

// «Деньги в кассе прямо сейчас» (нал + безнал). Если смена открыта — это её
// живой расчёт ожидаемого; если открытой смены нет — остаток закрытой кассы
// (пересчитано при закрытии минус то, что после этого изъяли/потратили).
export async function getCurrentTill(): Promise<{
  cash: number; wallet: number; shift: any | null;
}> {
  const shift = await getAnyOpenShift();
  if (shift) {
    const exp = await computeExpected(shift);
    return { cash: exp.cash, wallet: exp.wallet, shift };
  }
  const closed = await getClosedTill();
  return { cash: closed.cash, wallet: closed.wallet, shift: null };
}

// Подотчёт сотрудника («на руках») — сквозной, не по сменам: сколько человек
// изъял из кассы себе на руки за вычетом того, что из этих денег потратил
// (расходы «из подотчёта» и оплаты поставщикам «из подотчёта»). Это и есть
// «сколько у него должно остаться на руках».
export async function computeAccountable(userId: string): Promise<{
  withdrawn: number; spent_expenses: number; spent_suppliers: number; adjustments: number; on_hand: number;
}> {
  const r = (
    await query<{ withdrawn: number; spent_expenses: number; spent_suppliers: number; adjustments: number }>(
      `SELECT
         (SELECT COALESCE(SUM(amount),0) FROM cash_withdrawals WHERE user_id = $1) AS withdrawn,
         (SELECT COALESCE(SUM(amount),0) FROM expenses
            WHERE user_id = $1 AND status = 'approved' AND paid_from = 'hand') AS spent_expenses,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments
            WHERE user_id = $1 AND source = 'hand') AS spent_suppliers,
         (SELECT COALESCE(SUM(amount),0) FROM accountable_adjustments WHERE user_id = $1) AS adjustments`,
      [userId],
    )
  )[0];
  const withdrawn = Number(r.withdrawn);
  const spent_expenses = Number(r.spent_expenses);
  const spent_suppliers = Number(r.spent_suppliers);
  const adjustments = Number(r.adjustments);
  return {
    withdrawn,
    spent_expenses,
    spent_suppliers,
    adjustments,
    on_hand: Number((withdrawn - spent_expenses - spent_suppliers + adjustments).toFixed(2)),
  };
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
         (SELECT COALESCE(SUM(amount),0) FROM cash_withdrawals WHERE shift_id = $1 AND kind='cash' AND amount > 0) AS withdrawn,
         (SELECT COALESCE(SUM(amount),0) FROM cash_withdrawals WHERE shift_id = $1 AND kind='wallet' AND amount > 0) AS wallet_withdrawn,
         (SELECT COALESCE(-SUM(amount),0) FROM cash_withdrawals WHERE shift_id = $1 AND amount < 0) AS deposited,
         (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE shift_id = $1 AND status='approved' AND paid_from='register' AND kind='cash') AS spent_cash,
         (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE shift_id = $1 AND status='approved' AND paid_from='register' AND kind='wallet') AS spent_wallet,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments WHERE shift_id = $1 AND source='cash') AS supplier_cash,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments WHERE shift_id = $1 AND source='wallet') AS supplier_wallet`,
      [shift.id],
    )
  )[0];
  res.json({ shift, expected_cash: exp.cash, expected_wallet: exp.wallet, stats });
});

// Остаток на старте смены (нал + безнал) для приёма кассы.
shiftsRouter.get('/expected-opening', async (_req, res) => {
  res.json(await getClosedTill());
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

  const prev = await getClosedTill();
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
      void notifyRequest({ userId: req.user!.id, what: 'открыть смену с расхождением' });
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
  void notifyShiftOpen({ userId, cash: openingCash, wallet: openingWallet, cashDiff, walletDiff, approved: !!approvedBy });
  return shift;
}

// Изъятие из кассы (инкассация) — владелец. kind: 'cash' (наличные) | 'wallet' (безнал).
shiftsRouter.post('/withdraw', requireOwner, async (req, res) => {
  const amount = Number(req.body?.amount);
  const kind = req.body?.kind === 'wallet' ? 'wallet' : 'cash';
  const note = String(req.body?.note ?? '').trim() || null;
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма изъятия должна быть больше нуля' });

  // Изымать можно и при открытой смене, и из закрытой кассы (вечером, после
  // закрытия смены кассиром) — отдельную смену ради изъятия открывать не нужно.
  const { avail, shift } = await tillAvailable(kind);
  if (amount > avail + 1e-9) {
    return res.status(400).json({ error: tillShortMessage(kind, avail, amount, shift, 'изъять') });
  }

  await query(`INSERT INTO cash_withdrawals (shift_id, amount, note, kind, user_id) VALUES ($1,$2,$3,$4,$5)`,
    [shift?.id ?? null, amount, note, kind, req.user!.id]);
  await writeLog({
    type: 'cash_withdraw', entity: 'shift', entityId: shift?.id ?? null, userId: req.user!.id,
    details: { amount, kind, note, closed_till: !shift || undefined },
  });
  if (shift) broadcast('shift', shift);
  else broadcast('data_updated', { kind: 'withdraw' });
  void notifyWithdraw({ userId: req.user!.id, amount, kind, note });
  res.status(201).json({ ok: true });
});

// Внести в кассу размен (сдачу) из денег на руках владельца — обратное изъятию:
// «на руках» −сумма, касса +сумма. Пишем в таблицу изъятий с ОТРИЦАТЕЛЬНОЙ
// суммой: касса смены, закрытый ящик и подотчёт учитывают это автоматически
// и одинаково. Смена открыта — к ней; закрыта — в закрытый ящик (к утру).
async function depositToTill(userId: string, amount: number, kind: 'cash' | 'wallet', note: string | null) {
  const acc = await computeAccountable(userId);
  if (amount > acc.on_hand + 1e-9) {
    throw { status: 400, message: `На руках только ${acc.on_hand.toFixed(2)} — внести ${amount.toFixed(2)} нельзя` };
  }
  const shift = await getAnyOpenShift();
  await query(`INSERT INTO cash_withdrawals (shift_id, amount, note, kind, user_id) VALUES ($1,$2,$3,$4,$5)`,
    [shift?.id ?? null, -amount, note, kind, userId]);
  await writeLog({
    type: 'cash_deposit', entity: 'shift', entityId: shift?.id ?? null, userId,
    details: { amount, kind, note, closed_till: !shift || undefined },
  });
  if (shift) broadcast('shift', shift);
  else broadcast('data_updated', { kind: 'deposit' });
  void notifyDeposit({ userId, amount, kind, note });
  return shift;
}

shiftsRouter.post('/deposit', requireOwner, async (req, res) => {
  const amount = Number(req.body?.amount);
  const kind = req.body?.kind === 'wallet' ? 'wallet' : 'cash';
  const note = String(req.body?.note ?? '').trim() || 'размен на сдачу';
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма должна быть больше нуля' });
  try {
    await depositToTill(req.user!.id, amount, kind, note);
    res.status(201).json({ ok: true });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
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
      void notifyRequest({ userId: req.user!.id, what: 'закрыть смену с расхождением' });
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
  // Моментальный полный «итог» в Telegram: сверка смены + итоги дня + баланс.
  void sendShiftCloseReport({
    userId: shift.user_id,
    expCash: exp.cash, countedCash, cashDiff,
    expWallet: exp.wallet, countedWallet, walletDiff,
    approved: !!approvedBy,
  });
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
    // «Это размен с моих рук»: лишнее при приёме — не излишек из ниоткуда, а
    // деньги, которые положили на сдачу. Вносим их в кассу с рук владельца —
    // тогда касса принимается без расхождения, а «на руках» уменьшается.
    if (req.body?.as_deposit) {
      const before = await getClosedTill();
      const dCash = Number((Number(r.counted_cash) - before.cash).toFixed(2));
      const dWallet = Number((Number(r.counted_wallet) - before.wallet).toFixed(2));
      try {
        if (dCash > 0) await depositToTill(req.user!.id, dCash, 'cash', 'размен на сдачу (при приёме кассы)');
        if (dWallet > 0) await depositToTill(req.user!.id, dWallet, 'wallet', 'размен на сдачу (при приёме кассы)');
      } catch (err: any) {
        if (err?.status) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    }
    const prev = await getClosedTill();
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
