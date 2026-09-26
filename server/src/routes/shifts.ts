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

// Любая открытая смена на точке (касса одна — активная смена одна).
async function getAnyOpenShift() {
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
async function computeExpected(shift: any): Promise<{ cash: number; wallet: number }> {
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

  // Возврат отдаётся наличными из кассы — уменьшает наличные.
  const cash = Number((Number(shift.opening_cash) + Number(s.cash_sales) - Number(s.refunds) - cashWd).toFixed(2));
  const wallet = Number((Number(shift.opening_wallet ?? 0) + Number(s.card_sales) - walletWd).toFixed(2));
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
         (SELECT COALESCE(SUM(amount),0) FROM cash_withdrawals WHERE shift_id = $1 AND kind='wallet') AS wallet_withdrawn`,
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

  try {
    const shift = (
      await query(
        `INSERT INTO shifts (user_id, opening_cash, opening_expected, opening_wallet, opening_wallet_expected)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.user!.id, openingCash, prev.cash, openingWallet, prev.wallet],
      )
    )[0];
    await writeLog({
      type: 'shift_open', entity: 'shift', entityId: shift.id, userId: req.user!.id,
      details: { opening_cash: openingCash, opening_wallet: openingWallet, expected_cash: prev.cash, expected_wallet: prev.wallet },
    });
    // Расхождение при приёме — по каждой кассе отдельно.
    const cashDiff = Number((openingCash - prev.cash).toFixed(2));
    const walletDiff = Number((openingWallet - prev.wallet).toFixed(2));
    if (cashDiff !== 0 || walletDiff !== 0) {
      await writeLog({
        type: 'handover_discrepancy', entity: 'shift', entityId: shift.id, userId: req.user!.id,
        details: {
          cash: { expected: prev.cash, counted: openingCash, difference: cashDiff },
          wallet: { expected: prev.wallet, counted: openingWallet, difference: walletDiff },
        },
      });
    }
    broadcast('shift', shift);
    res.status(201).json({ shift, expected: prev, handover: { cash: cashDiff, wallet: walletDiff } });
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'already_open' });
    throw err;
  }
});

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
    type: 'shift_close', entity: 'shift', entityId: shift.id, userId: req.user!.id,
    details: {
      cash: { expected: exp.cash, counted: countedCash, difference: cashDiff },
      wallet: { expected: exp.wallet, counted: countedWallet, difference: walletDiff },
      closed_by_owner: shift.user_id !== req.user!.id || undefined,
    },
  });
  if (cashDiff !== 0 || walletDiff !== 0) {
    await writeLog({
      type: 'cash_discrepancy', entity: 'shift', entityId: shift.id, userId: req.user!.id,
      details: { cash_difference: cashDiff, wallet_difference: walletDiff },
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
