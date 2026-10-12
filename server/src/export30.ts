// Выгрузка «всё за последние 30 дней» одним JSON — для сборки отчётной таблицы.
// Запуск на сервере:
//   docker compose exec -T app npm run export:30d > kassa-export.json
// Человеческие сообщения идут в stderr, в stdout — ТОЛЬКО чистый JSON.

import { query } from './db.js';
import { getCurrentTill } from './routes/shifts.js';

const TZ = process.env.STORE_TIMEZONE || 'Asia/Dushanbe';
const LOW = Number(process.env.TELEGRAM_LOW_STOCK_THRESHOLD || 4);

// Окно: последние 30 суток.
const SINCE = `now() - interval '30 days'`;

function num(v: unknown): number {
  return Number(v) || 0;
}

async function main() {
  console.error('Kassa: собираю данные за последние 30 дней…');

  // 1. Итоги периода по продажам.
  const sales = (
    await query<any>(
      `SELECT COUNT(*) AS receipts,
              COALESCE(SUM(total),0)                       AS revenue,
              COALESCE(SUM(cost_total),0)                  AS cost,
              COALESCE(SUM(COALESCE(cash_amount,total)),0) AS cash,
              COALESCE(SUM(COALESCE(card_amount,0)),0)     AS card
         FROM sales WHERE created_at >= ${SINCE}`,
    )
  )[0];
  const returnsTot = num(
    (await query<any>(`SELECT COALESCE(SUM(total),0) AS t FROM returns WHERE created_at >= ${SINCE}`))[0].t,
  );
  const expApproved = num(
    (await query<any>(`SELECT COALESCE(SUM(amount),0) AS t FROM expenses WHERE status='approved' AND created_at >= ${SINCE}`))[0].t,
  );
  const writeoffsTot = num(
    (await query<any>(`SELECT COALESCE(SUM(loss_value),0) AS t FROM write_offs WHERE created_at >= ${SINCE}`))[0].t,
  );
  const withdrawalsTot = num(
    (await query<any>(`SELECT COALESCE(SUM(amount),0) AS t FROM cash_withdrawals WHERE created_at >= ${SINCE}`))[0].t,
  );
  const spBySource = await query<any>(
    `SELECT source, COALESCE(SUM(amount),0) AS sum, COUNT(*) AS n
       FROM supplier_payments WHERE created_at >= ${SINCE} GROUP BY source`,
  );
  const revenue = num(sales.revenue);
  const cost = num(sales.cost);
  const margin = Number((revenue - cost).toFixed(2));
  const summary = {
    period_days: 30,
    receipts: num(sales.receipts),
    revenue,
    revenue_net_of_returns: Number((revenue - returnsTot).toFixed(2)),
    cost,
    margin,
    margin_pct: revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : 0,
    avg_check: num(sales.receipts) > 0 ? Number((revenue / num(sales.receipts)).toFixed(2)) : 0,
    cash_sales: num(sales.cash),
    card_sales: num(sales.card),
    returns_total: returnsTot,
    expenses_approved: expApproved,
    net_profit: Number((margin - expApproved).toFixed(2)),
    writeoffs_loss: writeoffsTot,
    withdrawals_total: withdrawalsTot,
    supplier_payments_by_source: spBySource.map((r) => ({ source: r.source, sum: num(r.sum), count: num(r.n) })),
  };

  // 2. По дням (в зоне магазина).
  const daily = await query<any>(
    `WITH d AS (
       SELECT (created_at AT TIME ZONE '${TZ}')::date AS day,
              total, cost_total, COALESCE(cash_amount,total) AS cash, COALESCE(card_amount,0) AS card
         FROM sales WHERE created_at >= ${SINCE}
     )
     SELECT day,
            COUNT(*) AS receipts,
            COALESCE(SUM(total),0)      AS revenue,
            COALESCE(SUM(cost_total),0) AS cost,
            COALESCE(SUM(cash),0)       AS cash,
            COALESCE(SUM(card),0)       AS card
       FROM d GROUP BY day ORDER BY day`,
  );
  const dailyExp = await query<any>(
    `SELECT (created_at AT TIME ZONE '${TZ}')::date AS day, COALESCE(SUM(amount),0) AS sum
       FROM expenses WHERE status='approved' AND created_at >= ${SINCE} GROUP BY day`,
  );
  const dailyRet = await query<any>(
    `SELECT (created_at AT TIME ZONE '${TZ}')::date AS day, COALESCE(SUM(total),0) AS sum
       FROM returns WHERE created_at >= ${SINCE} GROUP BY day`,
  );
  const expByDay = new Map(dailyExp.map((r) => [String(r.day), num(r.sum)]));
  const retByDay = new Map(dailyRet.map((r) => [String(r.day), num(r.sum)]));
  const dailyRows = daily.map((r) => {
    const rev = num(r.revenue);
    const marg = Number((rev - num(r.cost)).toFixed(2));
    const exp = expByDay.get(String(r.day)) || 0;
    return {
      day: String(r.day),
      receipts: num(r.receipts),
      revenue: rev,
      cost: num(r.cost),
      margin: marg,
      cash: num(r.cash),
      card: num(r.card),
      returns: retByDay.get(String(r.day)) || 0,
      expenses: exp,
      net_profit: Number((marg - exp).toFixed(2)),
    };
  });

  // 3. Смены за период.
  const shifts = await query<any>(
    `SELECT s.opened_at, s.closed_at, s.status, u.full_name, u.username,
            s.opening_cash, s.opening_wallet,
            s.expected_cash, s.counted_cash, s.difference,
            s.expected_wallet, s.counted_wallet, s.wallet_difference
       FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE s.opened_at >= ${SINCE} ORDER BY s.opened_at`,
  );

  // 4. Расходы (все статусы, чтобы было видно и запрошенные).
  const expenses = await query<any>(
    `SELECT e.created_at, e.category, e.amount, e.kind, e.paid_from, e.status, e.note,
            u.full_name, u.username
       FROM expenses e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.created_at >= ${SINCE} ORDER BY e.created_at`,
  );

  // 5. Оплаты поставщикам.
  const supplierPayments = await query<any>(
    `SELECT p.created_at, sup.name AS supplier, p.amount, p.source, p.note,
            u.full_name, u.username
       FROM supplier_payments p
       JOIN supplier_invoices i ON i.id = p.invoice_id
       JOIN suppliers sup ON sup.id = i.supplier_id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.created_at >= ${SINCE} ORDER BY p.created_at`,
  );

  // 6. Изъятия из кассы (инкассация / подотчёт).
  const withdrawals = await query<any>(
    `SELECT w.created_at, w.amount, w.kind, w.note, u.full_name, u.username
       FROM cash_withdrawals w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.created_at >= ${SINCE} ORDER BY w.created_at`,
  );

  // 7. Списания товара.
  const writeoffs = await query<any>(
    `SELECT created_at, name, qty, unit_cost, loss_value, reason,
            (SELECT full_name FROM users WHERE id = write_offs.user_id) AS full_name
       FROM write_offs WHERE created_at >= ${SINCE} ORDER BY created_at`,
  );

  // 8. Возвраты.
  const returns = await query<any>(
    `SELECT r.created_at, r.total, r.reason, u.full_name, u.username
       FROM returns r LEFT JOIN users u ON u.id = r.user_id
      WHERE r.created_at >= ${SINCE} ORDER BY r.created_at`,
  );

  // 9. Инвентаризации (недостача).
  const inventories = await query<any>(
    `SELECT i.created_at, u.full_name,
            (SELECT COUNT(*) FROM inventory_items WHERE inventory_id = i.id) AS items,
            (SELECT COALESCE(SUM(loss_value),0) FROM inventory_items WHERE inventory_id = i.id) AS total_loss
       FROM inventories i LEFT JOIN users u ON u.id = i.user_id
      WHERE i.created_at >= ${SINCE} ORDER BY i.created_at`,
  );

  // 10. Текущий баланс: касса + подотчёт по сотрудникам + долг поставщикам.
  const till = await getCurrentTill();
  const hands = await query<any>(
    `SELECT u.full_name, u.username,
            COALESCE((SELECT SUM(amount) FROM cash_withdrawals WHERE user_id=u.id),0) AS withdrawn,
            COALESCE((SELECT SUM(amount) FROM expenses WHERE user_id=u.id AND status='approved' AND paid_from='hand'),0) AS ex_hand,
            COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE user_id=u.id AND source='hand'),0) AS sp_hand,
            COALESCE((SELECT SUM(amount) FROM accountable_adjustments WHERE user_id=u.id),0) AS adj
       FROM users u`,
  );
  const handsRows = hands
    .map((h) => ({
      who: h.full_name || h.username,
      on_hand: Number((num(h.withdrawn) - num(h.ex_hand) - num(h.sp_hand) + num(h.adj)).toFixed(2)),
    }))
    .filter((h) => h.on_hand !== 0);
  const supplierDebt = num(
    (await query<any>(`SELECT COALESCE(SUM(total - paid),0) AS d FROM supplier_invoices`))[0].d,
  );
  const handsTotal = Number(handsRows.reduce((s, h) => s + h.on_hand, 0).toFixed(2));
  const tillTotal = Number((num(till.cash) + num(till.wallet)).toFixed(2));
  const balanceNow = {
    till_cash: num(till.cash),
    till_wallet: num(till.wallet),
    till_total: tillTotal,
    hands: handsRows,
    hands_total: handsTotal,
    total_cash: Number((tillTotal + handsTotal).toFixed(2)),
    supplier_debt: supplierDebt,
  };

  // 11. Топ товаров по выручке за период.
  const topProducts = await query<any>(
    `SELECT si.name,
            SUM(si.qty)                          AS qty,
            SUM(si.line_total)                   AS revenue,
            SUM(si.line_total - si.qty*si.unit_cost) AS margin
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.created_at >= ${SINCE}
      GROUP BY si.name ORDER BY revenue DESC LIMIT 50`,
  );

  // 12. Долги по поставщикам (текущие).
  const suppliersDebt = await query<any>(
    `SELECT s.name, COALESCE(SUM(i.total - i.paid),0) AS debt
       FROM suppliers s LEFT JOIN supplier_invoices i ON i.supplier_id = s.id
      GROUP BY s.name HAVING COALESCE(SUM(i.total - i.paid),0) > 0
      ORDER BY debt DESC`,
  );

  // 13. Текущие низкие остатки (пора закупить).
  const lowStock = await query<any>(
    `SELECT name, unit, stock, cost_price FROM products
      WHERE is_archived=false AND stock < $1 ORDER BY stock ASC`,
    [LOW],
  );

  const out = {
    generated_at: new Date().toISOString(),
    timezone: TZ,
    low_stock_threshold: LOW,
    summary,
    daily: dailyRows,
    shifts: shifts.map((s) => ({
      opened_at: s.opened_at, closed_at: s.closed_at, status: s.status,
      who: s.full_name || s.username,
      opening_cash: num(s.opening_cash), opening_wallet: num(s.opening_wallet),
      expected_cash: s.expected_cash == null ? null : num(s.expected_cash),
      counted_cash: s.counted_cash == null ? null : num(s.counted_cash),
      cash_diff: s.difference == null ? null : num(s.difference),
      expected_wallet: s.expected_wallet == null ? null : num(s.expected_wallet),
      counted_wallet: s.counted_wallet == null ? null : num(s.counted_wallet),
      wallet_diff: s.wallet_difference == null ? null : num(s.wallet_difference),
    })),
    expenses: expenses.map((e) => ({
      created_at: e.created_at, category: e.category, amount: num(e.amount),
      kind: e.kind, paid_from: e.paid_from, status: e.status, note: e.note,
      who: e.full_name || e.username,
    })),
    supplier_payments: supplierPayments.map((p) => ({
      created_at: p.created_at, supplier: p.supplier, amount: num(p.amount),
      source: p.source, note: p.note, who: p.full_name || p.username,
    })),
    withdrawals: withdrawals.map((w) => ({
      created_at: w.created_at, amount: num(w.amount), kind: w.kind, note: w.note,
      who: w.full_name || w.username,
    })),
    writeoffs: writeoffs.map((w) => ({
      created_at: w.created_at, name: w.name, qty: num(w.qty), unit_cost: num(w.unit_cost),
      loss_value: num(w.loss_value), reason: w.reason, who: w.full_name,
    })),
    returns: returns.map((r) => ({
      created_at: r.created_at, total: num(r.total), reason: r.reason,
      who: r.full_name || r.username,
    })),
    inventories: inventories.map((i) => ({
      created_at: i.created_at, who: i.full_name, items: num(i.items), total_loss: num(i.total_loss),
    })),
    balance_now: balanceNow,
    top_products: topProducts.map((p) => ({
      name: p.name, qty: num(p.qty), revenue: num(p.revenue), margin: num(p.margin),
    })),
    suppliers_debt: suppliersDebt.map((s) => ({ name: s.name, debt: num(s.debt) })),
    low_stock: lowStock.map((p) => ({
      name: p.name, unit: p.unit, stock: num(p.stock), cost_price: num(p.cost_price),
    })),
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  console.error('Готово. JSON выведен в stdout.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Ошибка экспорта:', err?.message || err);
  process.exit(1);
});
