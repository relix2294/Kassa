// Лента подотчёта: ВСЕ движения денег, которые касаются «на руках», в одном
// хронологическом списке с бегущим остатком. Нужна владельцу, чтобы сверить
// цифру «на руках» с реальными деньгами у сотрудника: видно каждое изъятие,
// каждый расход и каждую оплату поставщику, и как они двигали остаток.
//
// Правила (те же, что в computeAccountable и /dashboard/balance — цифры обязаны
// совпадать):
//   изъятие из кассы            → на руках +сумма
//   внесение в кассу (размен)   → на руках −сумма (хранится как изъятие с минусом)
//   расход «из подотчёта»       → на руках −сумма
//   оплата поставщику «из рук»  → на руках −сумма
//   сверка (корректировка)      → на руках ±сумма
// Остальное (расходы из кассы, оплаты поставщикам из кассы / со стороны)
// показываем для полноты, но на «на руках» оно не влияет (0).
// Строки без сотрудника (user_id пуст или удалён) в подотчёт не входят — как
// и в Кабинете.

import { query } from '../db.js';

export type LedgerType = 'withdrawal' | 'deposit' | 'expense' | 'supplier' | 'adjustment';

export interface LedgerRow {
  id: string;
  at: string;
  type: LedgerType;
  title: string;
  note: string | null;
  who: string;
  amount: number;
  // Откуда/куда: для изъятия — 'cash'|'wallet'; для расхода — 'hand'|'register';
  // для оплаты поставщику — 'hand'|'cash'|'wallet'|'external'; для сверки — 'adjust'.
  source: string;
  hand_effect: number;
  balance: number;
  // false — строка без сотрудника: в подотчёт не входит (как и в Кабинете).
  assigned: boolean;
}

export interface LedgerTotals {
  withdrawn_cash: number;
  withdrawn_wallet: number;
  withdrawn: number;
  // Внесено в кассу с рук (размен на сдачу) — обратное изъятию.
  deposited_cash: number;
  deposited_wallet: number;
  deposited: number;
  expenses_hand: number;
  expenses_register: number;
  supplier_hand: number;
  supplier_cash: number;
  supplier_wallet: number;
  supplier_external: number;
  adjustments: number;
  // Изменение «на руках» за период (сумма hand_effect).
  hand_change: number;
  // Строки без сотрудника — не входят в подотчёт (для контроля).
  unassigned: number;
}

export interface Ledger {
  rows: LedgerRow[];
  on_hand: number;
  totals_all: LedgerTotals;
  last_adjustment: { at: string; amount: number; balance_after: number } | null;
  // Всё, что было ПОСЛЕ последней сверки: с какой цифры начали и что изменилось.
  since: { from: string | null; start_balance: number; totals: LedgerTotals; rows: number };
}

const r2 = (n: number) => Number(n.toFixed(2));

function emptyTotals(): LedgerTotals {
  return {
    withdrawn_cash: 0, withdrawn_wallet: 0, withdrawn: 0,
    deposited_cash: 0, deposited_wallet: 0, deposited: 0,
    expenses_hand: 0, expenses_register: 0,
    supplier_hand: 0, supplier_cash: 0, supplier_wallet: 0, supplier_external: 0,
    adjustments: 0, hand_change: 0, unassigned: 0,
  };
}

function addToTotals(t: LedgerTotals, row: LedgerRow): void {
  if (!row.assigned) { t.unassigned += row.amount; return; }
  switch (row.type) {
    case 'withdrawal':
      if (row.source === 'wallet') t.withdrawn_wallet += row.amount; else t.withdrawn_cash += row.amount;
      t.withdrawn += row.amount;
      break;
    case 'deposit':
      if (row.source === 'wallet') t.deposited_wallet += row.amount; else t.deposited_cash += row.amount;
      t.deposited += row.amount;
      break;
    case 'expense':
      if (row.source === 'hand') t.expenses_hand += row.amount; else t.expenses_register += row.amount;
      break;
    case 'supplier':
      if (row.source === 'hand') t.supplier_hand += row.amount;
      else if (row.source === 'cash') t.supplier_cash += row.amount;
      else if (row.source === 'wallet') t.supplier_wallet += row.amount;
      else t.supplier_external += row.amount;
      break;
    case 'adjustment':
      t.adjustments += row.amount;
      break;
  }
  t.hand_change += row.hand_effect;
}

function roundTotals(t: LedgerTotals): LedgerTotals {
  const o = { ...t };
  for (const k of Object.keys(o) as (keyof LedgerTotals)[]) o[k] = r2(o[k]);
  return o;
}

interface RawRow {
  id: string; at: Date | string; type: LedgerType; title: string; note: string | null;
  who: string | null; assigned: boolean; amount: string | number; source: string;
}

export async function buildLedger(): Promise<Ledger> {
  const raw = await query<RawRow>(
    `SELECT * FROM (
       -- Внесение в кассу (размен с рук) хранится как изъятие с минусом.
       SELECT w.id, w.created_at AS at,
              CASE WHEN w.amount < 0 THEN 'deposit' ELSE 'withdrawal' END AS type,
              CASE WHEN w.amount < 0 THEN 'Внесено в кассу (размен)' ELSE 'Изъятие из кассы' END AS title, w.note,
              COALESCE(u.full_name, u.username) AS who, (u.id IS NOT NULL) AS assigned,
              ABS(w.amount) AS amount, COALESCE(w.kind, 'cash') AS source
         FROM cash_withdrawals w LEFT JOIN users u ON u.id = w.user_id
       UNION ALL
       SELECT e.id, e.created_at, 'expense',
              'Расход: ' || e.category, e.note,
              COALESCE(u.full_name, u.username), (u.id IS NOT NULL),
              e.amount, e.paid_from
         FROM expenses e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.status = 'approved'
       UNION ALL
       SELECT p.id, p.created_at, 'supplier',
              'Оплата поставщику: ' || COALESCE(s.name, '—'), p.note,
              COALESCE(u.full_name, u.username), (u.id IS NOT NULL),
              p.amount, p.source
         FROM supplier_payments p
         LEFT JOIN supplier_invoices i ON i.id = p.invoice_id
         LEFT JOIN suppliers s ON s.id = i.supplier_id
         LEFT JOIN users u ON u.id = p.user_id
       UNION ALL
       SELECT a.id, a.created_at, 'adjustment',
              'Сверка остатка на руках', a.note,
              COALESCE(u.full_name, u.username), (u.id IS NOT NULL),
              a.amount, 'adjust'
         FROM accountable_adjustments a LEFT JOIN users u ON u.id = a.user_id
     ) x
     ORDER BY at ASC, id ASC`,
  );

  const rows: LedgerRow[] = [];
  const totalsAll = emptyTotals();
  let balance = 0;
  let lastAdjIdx = -1;

  for (const r of raw) {
    const amount = Number(r.amount);
    let effect = 0;
    if (r.assigned) {
      if (r.type === 'withdrawal') effect = amount;
      else if (r.type === 'deposit') effect = -amount;
      else if (r.type === 'expense' && r.source === 'hand') effect = -amount;
      else if (r.type === 'supplier' && r.source === 'hand') effect = -amount;
      else if (r.type === 'adjustment') effect = amount;
    }
    balance = r2(balance + effect);
    const row: LedgerRow = {
      id: r.id,
      at: new Date(r.at).toISOString(),
      type: r.type,
      title: r.title,
      note: r.note,
      who: r.who || '— (без сотрудника)',
      amount: r2(amount),
      source: r.source,
      hand_effect: r2(effect),
      balance,
      assigned: r.assigned,
    };
    addToTotals(totalsAll, row);
    if (r.type === 'adjustment' && r.assigned) lastAdjIdx = rows.length;
    rows.push(row);
  }

  // Всё после последней сверки (или с самого начала, если сверок не было).
  const sinceTotals = emptyTotals();
  const startBalance = lastAdjIdx >= 0 ? rows[lastAdjIdx].balance : 0;
  const sinceRows = rows.slice(lastAdjIdx + 1);
  for (const row of sinceRows) addToTotals(sinceTotals, row);

  return {
    rows,
    on_hand: balance,
    totals_all: roundTotals(totalsAll),
    last_adjustment: lastAdjIdx >= 0
      ? { at: rows[lastAdjIdx].at, amount: rows[lastAdjIdx].amount, balance_after: rows[lastAdjIdx].balance }
      : null,
    since: {
      from: lastAdjIdx >= 0 ? rows[lastAdjIdx].at : null,
      start_balance: startBalance,
      totals: roundTotals(sinceTotals),
      rows: sinceRows.length,
    },
  };
}
