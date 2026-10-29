import { Router } from 'express';
import { query } from '../db.js';
import { requireOwner } from '../lib/auth.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { getCurrentTill, computeAccountable } from './shifts.js';
import { buildLedger } from '../lib/ledger.js';

export const dashboardRouter = Router();

// Кабинет владельца — только владелец (кассир не видит выручку и маржу).
dashboardRouter.use(requireOwner);

// Часовой пояс магазина: без него «сегодня» считается по времени сервера и
// выручка за день съезжает, если сервер в другой зоне (п.27 аудита).
const TZ = process.env.STORE_TIMEZONE || 'Asia/Dushanbe';

// Начало сегодняшнего дня в зоне магазина (как timestamptz).
const TODAY = `date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
const TOMORROW = `(${TODAY} + interval '1 day')`;

// --- Баланс: «сколько денег у нас прямо сейчас» (живьём) ---
// Деньги магазина лежат в трёх местах:
//   1) касса — наличные в ящике и безнал на кошельках (расчёт смены);
//   2) подотчёт — деньги, которые сотрудники изъяли из кассы себе на руки,
//      за вычетом того, что из них потратили (расходы/оплаты «из подотчёта»);
// Долг поставщикам показываем отдельно — это НЕ наши деньги (мы их должны).
dashboardRouter.get('/balance', async (_req, res) => {
  const till = await getCurrentTill();

  // Подотчёт по каждому сотруднику: изъял − потратил из подотчёта.
  const hands = await query<{
    id: string; full_name: string | null; username: string;
    withdrawn: number; spent_expenses: number; spent_suppliers: number; adjustments: number;
  }>(
    `SELECT u.id, u.full_name, u.username,
            COALESCE(w.withdrawn,0)  AS withdrawn,
            COALESCE(e.spent,0)      AS spent_expenses,
            COALESCE(sp.paid,0)      AS spent_suppliers,
            COALESCE(adj.adj,0)      AS adjustments
       FROM users u
       LEFT JOIN (SELECT user_id, SUM(amount) AS withdrawn FROM cash_withdrawals GROUP BY user_id) w  ON w.user_id = u.id
       LEFT JOIN (SELECT user_id, SUM(amount) AS spent FROM expenses
                   WHERE status='approved' AND paid_from='hand' GROUP BY user_id) e  ON e.user_id = u.id
       LEFT JOIN (SELECT user_id, SUM(amount) AS paid FROM supplier_payments
                   WHERE source='hand' GROUP BY user_id) sp ON sp.user_id = u.id
       LEFT JOIN (SELECT user_id, SUM(amount) AS adj FROM accountable_adjustments GROUP BY user_id) adj ON adj.user_id = u.id
      WHERE COALESCE(w.withdrawn,0) <> 0 OR COALESCE(e.spent,0) <> 0 OR COALESCE(sp.paid,0) <> 0 OR COALESCE(adj.adj,0) <> 0
      ORDER BY (COALESCE(w.withdrawn,0) - COALESCE(e.spent,0) - COALESCE(sp.paid,0) + COALESCE(adj.adj,0)) DESC`,
  );
  const handsOut = hands.map((h) => ({
    user_id: h.id,
    name: h.full_name || h.username,
    withdrawn: Number(h.withdrawn),
    spent_expenses: Number(h.spent_expenses),
    spent_suppliers: Number(h.spent_suppliers),
    adjustments: Number(h.adjustments),
    on_hand: Number((Number(h.withdrawn) - Number(h.spent_expenses) - Number(h.spent_suppliers) + Number(h.adjustments)).toFixed(2)),
  }));
  const handsTotal = Number(handsOut.reduce((s, h) => s + h.on_hand, 0).toFixed(2));

  // Долг поставщикам (всего не оплачено).
  const debtRow = (
    await query<{ debt: number }>(`SELECT COALESCE(SUM(total - paid - returned),0) AS debt FROM supplier_invoices`)
  )[0];
  const supplierDebt = Number(debtRow.debt);

  // Движение денег за сегодня (в зоне магазина).
  const t = (
    await query<Record<string, number>>(
      `SELECT
         (SELECT COALESCE(SUM(COALESCE(cash_amount, total)),0) FROM sales
            WHERE created_at >= ${TODAY} AND created_at < ${TOMORROW}) AS sales_cash,
         (SELECT COALESCE(SUM(COALESCE(card_amount, 0)),0) FROM sales
            WHERE created_at >= ${TODAY} AND created_at < ${TOMORROW}) AS sales_card,
         (SELECT COALESCE(SUM(total),0) FROM returns
            WHERE created_at >= ${TODAY} AND created_at < ${TOMORROW}) AS refunds,
         (SELECT COALESCE(SUM(amount),0) FROM cash_withdrawals
            WHERE amount > 0 AND created_at >= ${TODAY} AND created_at < ${TOMORROW}) AS withdrawn,
         (SELECT COALESCE(SUM(amount),0) FROM expenses
            WHERE status='approved' AND paid_from='register'
              AND created_at >= ${TODAY} AND created_at < ${TOMORROW}) AS expenses_register,
         (SELECT COALESCE(SUM(amount),0) FROM expenses
            WHERE status='approved' AND paid_from='hand'
              AND created_at >= ${TODAY} AND created_at < ${TOMORROW}) AS expenses_hand,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments
            WHERE source IN ('cash','wallet')
              AND created_at >= ${TODAY} AND created_at < ${TOMORROW}) AS supplier_till,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments
            WHERE source='hand'
              AND created_at >= ${TODAY} AND created_at < ${TOMORROW}) AS supplier_hand`,
    )
  )[0];
  const today = {
    sales_cash: Number(t.sales_cash),
    sales_card: Number(t.sales_card),
    refunds: Number(t.refunds),
    withdrawn: Number(t.withdrawn),
    expenses_register: Number(t.expenses_register),
    expenses_hand: Number(t.expenses_hand),
    supplier_till: Number(t.supplier_till),
    supplier_hand: Number(t.supplier_hand),
  };
  // Пришло = продажи (нал+безнал). Ушло = возвраты + расходы + оплаты
  // поставщикам (изъятие — не расход, деньги лишь перешли в подотчёт).
  const inTotal = Number((today.sales_cash + today.sales_card).toFixed(2));
  const outTotal = Number(
    (today.refunds + today.expenses_register + today.expenses_hand + today.supplier_till + today.supplier_hand).toFixed(2),
  );

  // Ленты для детализации: изъятия и одобренные расходы по датам/времени.
  const withdrawals = await query(
    `SELECT cw.id, cw.amount, cw.kind, cw.note, cw.created_at,
            u.full_name, u.username
       FROM cash_withdrawals cw LEFT JOIN users u ON u.id = cw.user_id
      ORDER BY cw.created_at DESC LIMIT 100`,
  );
  const expenses = await query(
    `SELECT e.id, e.amount, e.kind, e.category, e.note, e.paid_from, e.created_at,
            u.full_name, u.username
       FROM expenses e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.status='approved'
      ORDER BY e.created_at DESC LIMIT 100`,
  );

  const tillTotal = Number((Number(till.cash) + Number(till.wallet)).toFixed(2));
  res.json({
    till: {
      cash: Number(till.cash),
      wallet: Number(till.wallet),
      total: tillTotal,
      has_open_shift: !!till.shift,
      shift_user: till.shift ? (till.shift.full_name || till.shift.username || null) : null,
    },
    hands: handsOut,
    hands_total: handsTotal,
    supplier_debt: supplierDebt,
    // Всего наших денег = касса + на руках у сотрудников.
    total_cash: Number((tillTotal + handsTotal).toFixed(2)),
    today: { ...today, in_total: inTotal, out_total: outTotal },
    withdrawals,
    expenses,
  });
});

// Сверка подотчёта: владелец приводит остаток «на руках» сотрудника к факту.
// Тело: { user_id, on_hand (фактический остаток сейчас), note? }.
// Система считает разницу с текущим и записывает корректировку. Нужна, когда
// прошлые траты из подотчёта не были помечены «из подотчёта».
dashboardRouter.post('/accountable/adjust', async (req, res) => {
  const userId = String(req.body?.user_id ?? '');
  const target = Number(req.body?.on_hand);
  const note = String(req.body?.note ?? '').trim() || null;
  if (!userId) return res.status(400).json({ error: 'Нужен user_id' });
  if (!Number.isFinite(target)) return res.status(400).json({ error: 'on_hand должен быть числом' });

  const u = (await query(`SELECT id, full_name, username FROM users WHERE id = $1`, [userId]))[0];
  if (!u) return res.status(404).json({ error: 'Сотрудник не найден' });

  const acc = await computeAccountable(userId);
  const delta = Number((target - acc.on_hand).toFixed(2));
  if (delta === 0) return res.json({ ok: true, on_hand: acc.on_hand, delta: 0 });

  await query(
    `INSERT INTO accountable_adjustments (user_id, amount, note, created_by) VALUES ($1,$2,$3,$4)`,
    [userId, delta, note, req.user!.id],
  );
  await writeLog({
    type: 'accountable_adjust', entity: 'user', entityId: userId, userId: req.user!.id,
    details: { before: acc.on_hand, after: target, delta, note },
  });
  broadcast('data_updated', { kind: 'accountable_adjust' });
  res.json({ ok: true, on_hand: target, delta });
});

// Лента подотчёта: все изъятия, расходы, оплаты поставщикам и сверки по
// времени с бегущим остатком «на руках» — для сверки с реальными деньгами.
dashboardRouter.get('/ledger', async (_req, res) => {
  res.json(await buildLedger());
});

// Границы пресетов в виде SQL-выражений (строки заданы сервером — не ввод).
const PRESETS: Record<string, { lo: string; hi: string }> = {
  today: { lo: TODAY, hi: TOMORROW },
  yesterday: { lo: `(${TODAY} - interval '1 day')`, hi: TODAY },
  '7d': { lo: `(${TODAY} - interval '6 days')`, hi: TOMORROW },
  '30d': { lo: `(${TODAY} - interval '29 days')`, hi: TOMORROW },
  '90d': { lo: `(${TODAY} - interval '89 days')`, hi: TOMORROW },
  year: { lo: `(${TODAY} - interval '364 days')`, hi: TOMORROW },
  all: { lo: `timestamptz 'epoch'`, hi: TOMORROW },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Разрешаем период запроса в конкретные границы [lo, hi) и шаг графика.
// Поддерживает пресеты и произвольный диапазон (from/to — даты YYYY-MM-DD).
async function resolveBounds(q: any): Promise<{ lo: string; hi: string; bucket: 'hour' | 'day' }> {
  const period = String(q.period || '30d');
  let row: any;
  if (period === 'custom' && ISO_DATE.test(String(q.from)) && ISO_DATE.test(String(q.to))) {
    row = (
      await query(
        `SELECT ($1::date AT TIME ZONE '${TZ}') AS lo,
                (($2::date + 1) AT TIME ZONE '${TZ}') AS hi`,
        [q.from, q.to],
      )
    )[0];
  } else {
    const p = PRESETS[period] ?? PRESETS['30d'];
    row = (await query(`SELECT ${p.lo} AS lo, ${p.hi} AS hi`))[0];
  }
  const lo = new Date(row.lo).toISOString();
  const hi = new Date(row.hi).toISOString();
  // До ~2 суток показываем по часам, иначе по дням.
  const spanH = (new Date(hi).getTime() - new Date(lo).getTime()) / 36e5;
  return { lo, hi, bucket: spanH <= 48 ? 'hour' : 'day' };
}

// Сводка за период + сравнение с предыдущим равным периодом (рост/падение).
dashboardRouter.get('/summary', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  // Предыдущий период той же длины — непосредственно перед текущим.
  const span = `(($2::timestamptz) - ($1::timestamptz))`;
  const prevLo = `(($1::timestamptz) - ${span})`;

  const agg = async (from: string, to: string) =>
    (
      await query(
        `SELECT
           COUNT(*)                                        AS receipts,
           COALESCE(SUM(total),0)                          AS revenue,
           COALESCE(SUM(cost_total),0)                     AS cost,
           COALESCE(SUM(COALESCE(cash_amount, total)),0)   AS cash,
           COALESCE(SUM(COALESCE(card_amount, 0)),0)       AS card,
           COALESCE((SELECT SUM(qty) FROM sale_items si JOIN sales s2 ON s2.id=si.sale_id
                      WHERE s2.created_at >= $1 AND s2.created_at < $2),0) AS items
         FROM sales WHERE created_at >= $1 AND created_at < $2`,
        [from, to],
      )
    )[0];

  const cur = await agg(lo, hi);
  const prevBounds = (await query(`SELECT ${prevLo} AS lo`, [lo, hi]))[0];
  const prev = await agg(new Date(prevBounds.lo).toISOString(), lo);

  const refunds = (
    await query(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total
         FROM returns WHERE created_at >= $1 AND created_at < $2`,
      [lo, hi],
    )
  )[0];

  const expensesRow = (
    await query(
      `SELECT COALESCE(SUM(amount),0) AS total
         FROM expenses WHERE status='approved' AND created_at >= $1 AND created_at < $2`,
      [lo, hi],
    )
  )[0];

  const revenue = Number(cur.revenue);
  const cost = Number(cur.cost);
  const margin = Number((revenue - cost).toFixed(2));
  const receipts = Number(cur.receipts);
  const refundsTotal = Number(refunds.total);
  const prevRevenue = Number(prev.revenue);
  const prevMargin = Number((Number(prev.revenue) - Number(prev.cost)).toFixed(2));
  const expensesTotal = Number(expensesRow.total);

  res.json({
    from: lo,
    to: hi,
    receipts,
    revenue,
    net_revenue: Number((revenue - refundsTotal).toFixed(2)),
    margin,
    margin_pct: revenue > 0 ? Number(((margin / revenue) * 100).toFixed(1)) : 0,
    avg_check: receipts > 0 ? Number((revenue / receipts).toFixed(2)) : 0,
    items: Number(cur.items),
    cash: Number(cur.cash),
    card: Number(cur.card),
    refunds_count: Number(refunds.count),
    refunds_total: refundsTotal,
    expenses: expensesTotal,
    // Чистая прибыль = маржа − расходы (операционные затраты точки).
    net_profit: Number((margin - expensesTotal).toFixed(2)),
    // Сравнение с прошлым периодом (в процентах; null — не с чем сравнивать).
    prev: {
      revenue: prevRevenue,
      margin: prevMargin,
      receipts: Number(prev.receipts),
      revenue_change: prevRevenue > 0 ? Number((((revenue - prevRevenue) / prevRevenue) * 100).toFixed(1)) : null,
      margin_change: prevMargin > 0 ? Number((((margin - prevMargin) / prevMargin) * 100).toFixed(1)) : null,
    },
  });
});

// Временной ряд выручки/маржи/чеков по дням или часам (для графика динамики).
// Пропуски (дни без продаж) заполняем нулями, чтобы линия не «прыгала».
dashboardRouter.get('/timeseries', async (req, res) => {
  const { lo, hi, bucket } = await resolveBounds(req.query);
  const step = bucket === 'hour' ? `interval '1 hour'` : `interval '1 day'`;
  const trunc = `date_trunc('${bucket}', s.created_at AT TIME ZONE '${TZ}')`;

  const rows = await query(
    `WITH buckets AS (
       SELECT generate_series(
         date_trunc('${bucket}', ($1::timestamptz) AT TIME ZONE '${TZ}'),
         date_trunc('${bucket}', ($2::timestamptz - ${step}) AT TIME ZONE '${TZ}'),
         ${step}
       ) AS b
     )
     SELECT b AS bucket,
            COALESCE(SUM(s.total),0)                       AS revenue,
            COALESCE(SUM(s.total - s.cost_total),0)        AS margin,
            COUNT(s.id)                                    AS receipts
       FROM buckets
       LEFT JOIN sales s
         ON ${trunc} = buckets.b
        AND s.created_at >= $1 AND s.created_at < $2
      GROUP BY b ORDER BY b`,
    [lo, hi],
  );
  res.json({ bucket, points: rows });
});

// Топ товаров за период: по выручке / марже / количеству.
dashboardRouter.get('/top-products', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const sortBy = ['revenue', 'margin', 'qty'].includes(String(req.query.sort)) ? String(req.query.sort) : 'revenue';
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const rows = await query(
    `SELECT si.name, si.barcode, MAX(p.unit) AS unit,
            SUM(si.qty)        AS qty,
            SUM(si.line_total) AS revenue,
            SUM(si.line_total - si.unit_cost * si.qty) AS margin
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
      WHERE s.created_at >= $1 AND s.created_at < $2
      GROUP BY si.name, si.barcode
      ORDER BY ${sortBy} DESC
      LIMIT ${limit}`,
    [lo, hi],
  );
  res.json(rows);
});

// Число дней в периоде [lo, hi) — для расчётов «в день».
function periodDays(lo: string, hi: string): number {
  return Math.max(1, Math.round((new Date(hi).getTime() - new Date(lo).getTime()) / 86400000));
}

// ABC + данные для XYZ: по каждому товару за период — выручка/прибыль/кол-во и
// сумма квадратов дневных количеств (sumsq) для коэффициента вариации (XYZ).
// Классы A/B/C и X/Y/Z клиент считает сам. Без лимита — нужен весь список.
dashboardRouter.get('/abc', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const rows = await query(
    `WITH daily AS (
       SELECT si.name,
              date_trunc('day', s.created_at AT TIME ZONE '${TZ}') AS d,
              SUM(si.qty) AS q,
              SUM(si.line_total) AS rev,
              SUM(si.line_total - si.unit_cost * si.qty) AS marg,
              MAX(si.barcode) AS bc
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
        WHERE s.created_at >= $1 AND s.created_at < $2
        GROUP BY si.name, d
     )
     SELECT name, MAX(bc) AS barcode,
            SUM(q)      AS qty,
            SUM(rev)    AS revenue,
            SUM(marg)   AS margin,
            SUM(q * q)  AS sumsq
       FROM daily GROUP BY name
       ORDER BY revenue DESC`,
    [lo, hi],
  );
  res.json({ days: periodDays(lo, hi), rows });
});

// Оборачиваемость: по каждому активному товару — продано за период и текущий
// остаток. Клиент считает «на сколько хватит» и скорость продаж.
dashboardRouter.get('/turnover', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const rows = await query(
    `SELECT p.id, p.name, p.barcode, p.unit, p.stock, p.cost_price,
            COALESCE(sold.qty, 0) AS sold
       FROM products p
       LEFT JOIN (
         SELECT si.product_id, SUM(si.qty) AS qty
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE s.created_at >= $1 AND s.created_at < $2
          GROUP BY si.product_id
       ) sold ON sold.product_id = p.id
      WHERE p.is_archived = false
      ORDER BY sold DESC`,
    [lo, hi],
  );
  res.json({ days: periodDays(lo, hi), rows });
});

// Потери за период: списания (бой/порча) + недостачи по инвентаризации.
dashboardRouter.get('/losses', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const writeoffs = await query(
    `SELECT w.name, w.qty, w.loss_value, w.reason, w.created_at,
            u.full_name, u.username
       FROM write_offs w LEFT JOIN users u ON u.id = w.user_id
      WHERE w.created_at >= $1 AND w.created_at < $2
      ORDER BY w.loss_value DESC`,
    [lo, hi],
  );
  // Недостачи инвентаризации: позиции с отрицательной разницей за период.
  const shortage = await query(
    `SELECT ii.name, ii.difference, ii.loss_value, i.created_at
       FROM inventory_items ii JOIN inventories i ON i.id = ii.inventory_id
      WHERE i.created_at >= $1 AND i.created_at < $2 AND ii.difference < 0
      ORDER BY ii.loss_value ASC`,
    [lo, hi],
  );
  const woTotal = writeoffs.reduce((s: number, w: any) => s + Number(w.loss_value), 0);
  const invTotal = shortage.reduce((s: number, r: any) => s + Math.abs(Number(r.loss_value)), 0);
  res.json({
    writeoffs, inventory: shortage,
    writeoffs_total: Number(woTotal.toFixed(2)),
    inventory_loss: Number(invTotal.toFixed(2)),
    total: Number((woTotal + invTotal).toFixed(2)),
  });
});

// Возвраты за период: по причинам и по товарам.
dashboardRouter.get('/returns-stats', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const byReason = await query(
    `SELECT COALESCE(NULLIF(r.reason, ''), 'без причины') AS reason,
            COUNT(*) AS count, COALESCE(SUM(r.total), 0) AS total
       FROM returns r
      WHERE r.created_at >= $1 AND r.created_at < $2
      GROUP BY 1 ORDER BY total DESC`,
    [lo, hi],
  );
  const byProduct = await query(
    `SELECT ri.name, SUM(ri.qty) AS qty, COALESCE(SUM(ri.line_total), 0) AS total, COUNT(DISTINCT r.id) AS returns
       FROM return_items ri JOIN returns r ON r.id = ri.return_id
      WHERE r.created_at >= $1 AND r.created_at < $2
      GROUP BY ri.name ORDER BY total DESC`,
    [lo, hi],
  );
  const total = byReason.reduce((s: number, r: any) => s + Number(r.total), 0);
  res.json({ by_reason: byReason, by_product: byProduct, total: Number(total.toFixed(2)) });
});

// Рост/падение: выручка товара за период vs предыдущий равный период.
dashboardRouter.get('/product-trend', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const span = new Date(hi).getTime() - new Date(lo).getTime();
  const prevLo = new Date(new Date(lo).getTime() - span).toISOString();
  const rows = await query(
    `SELECT si.name,
            COALESCE(SUM(si.line_total) FILTER (WHERE s.created_at >= $1 AND s.created_at < $2), 0) AS cur,
            COALESCE(SUM(si.line_total) FILTER (WHERE s.created_at >= $3 AND s.created_at < $1), 0) AS prev
       FROM sale_items si JOIN sales s ON s.id = si.sale_id
      WHERE s.created_at >= $3 AND s.created_at < $2
      GROUP BY si.name`,
    [lo, hi, prevLo],
  );
  res.json(rows);
});

// Разрез по категориям: выручка и маржа.
dashboardRouter.get('/by-category', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const rows = await query(
    `SELECT COALESCE(NULLIF(p.category,''), 'Без категории') AS category,
            SUM(si.line_total)                         AS revenue,
            SUM(si.line_total - si.unit_cost * si.qty) AS margin
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       LEFT JOIN products p ON p.id = si.product_id
      WHERE s.created_at >= $1 AND s.created_at < $2
      GROUP BY 1 ORDER BY revenue DESC`,
    [lo, hi],
  );
  res.json(rows);
});

// Разрез по кассирам: выручка, чеки, маржа, средний чек.
dashboardRouter.get('/by-cashier', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const rows = await query(
    `SELECT COALESCE(u.full_name, u.username, '—') AS cashier,
            COUNT(s.id)                     AS receipts,
            COALESCE(SUM(s.total),0)        AS revenue,
            COALESCE(SUM(s.total - s.cost_total),0) AS margin
       FROM sales s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.created_at >= $1 AND s.created_at < $2
      GROUP BY 1 ORDER BY revenue DESC`,
    [lo, hi],
  );
  res.json(rows);
});

// Паттерн по часам дня (0–23), усреднённый по всему периоду — когда идёт торговля.
dashboardRouter.get('/by-hour', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const rows = await query(
    `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE '${TZ}')::int AS hour,
            COALESCE(SUM(total),0) AS revenue,
            COUNT(*)               AS receipts
       FROM sales
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1 ORDER BY 1`,
    [lo, hi],
  );
  res.json(rows);
});

// Полный список расходов за период (для раздела «Расходы»): кто внёс/одобрил,
// категория, сумма, касса, статус. Одобренные + отклонённые.
dashboardRouter.get('/expenses-list', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const rows = await query(
    `SELECT e.id, e.amount, e.kind, e.category, e.note, e.status, e.created_at,
            u.full_name AS by_name, u.username AS by_username,
            a.full_name AS approver_name, a.username AS approver_username
       FROM expenses e
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN users a ON a.id = e.approved_by
      WHERE e.status IN ('approved','rejected') AND e.created_at >= $1 AND e.created_at < $2
      ORDER BY e.created_at DESC`,
    [lo, hi],
  );
  res.json(rows);
});

// Расходы точки за период по категориям (только одобренные).
dashboardRouter.get('/expenses', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const rows = await query(
    `SELECT category, kind, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
       FROM expenses
      WHERE status='approved' AND created_at >= $1 AND created_at < $2
      GROUP BY category, kind ORDER BY total DESC`,
    [lo, hi],
  );
  res.json(rows);
});

// Разрез по дням недели (Пн–Вс): выручка и маржа. Виден лучший/худший день.
dashboardRouter.get('/by-weekday', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const rows = await query(
    `SELECT EXTRACT(ISODOW FROM created_at AT TIME ZONE '${TZ}')::int AS dow,
            COALESCE(SUM(total),0)              AS revenue,
            COALESCE(SUM(total - cost_total),0) AS margin,
            COUNT(*)                            AS receipts
       FROM sales
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1 ORDER BY 1`,
    [lo, hi],
  );
  res.json(rows);
});

// Разбивка оплат: наличные / безнал (карта) / смешанная.
dashboardRouter.get('/payment-split', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const rows = await query(
    `SELECT payment_method AS method,
            COUNT(*)               AS receipts,
            COALESCE(SUM(total),0) AS total
       FROM sales
      WHERE created_at >= $1 AND created_at < $2
      GROUP BY 1`,
    [lo, hi],
  );
  res.json(rows);
});

// Последние чеки — «продажи сейчас».
dashboardRouter.get('/recent-sales', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const rows = await query(
    `SELECT s.id, s.total, s.payment_method, s.created_at,
            u.username, u.full_name,
            (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) AS items
       FROM sales s LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT $1`,
    [limit],
  );
  res.json(rows);
});

// Поставщики: движение за период + разбивка «кому сколько оплачено».
// Источники платежей: cash/wallet (касса), hand (подотчёт, с рук), external (со стороны).
dashboardRouter.get('/supplier-stats', async (req, res) => {
  const { lo, hi } = await resolveBounds(req.query);
  const pay = (
    await query(
      `SELECT COALESCE(SUM(amount),0)                                  AS paid,
              COALESCE(SUM(amount) FILTER (WHERE source='cash'),0)     AS paid_cash,
              COALESCE(SUM(amount) FILTER (WHERE source='wallet'),0)   AS paid_wallet,
              COALESCE(SUM(amount) FILTER (WHERE source='hand'),0)     AS paid_hand,
              COALESCE(SUM(amount) FILTER (WHERE source='external'),0) AS paid_external,
              COALESCE(-SUM(amount) FILTER (WHERE amount < 0),0)       AS refunded,
              COUNT(*) FILTER (WHERE amount > 0)                       AS payments
         FROM supplier_payments
        WHERE created_at >= $1 AND created_at < $2`,
      [lo, hi],
    )
  )[0];
  const inv = (
    await query(
      `SELECT COALESCE(SUM(total),0) AS purchased, COUNT(*) AS invoices
         FROM supplier_invoices
        WHERE created_at >= $1 AND created_at < $2`,
      [lo, hi],
    )
  )[0];
  // Возвраты товара поставщикам за период (на какую сумму нам засчитали).
  const rets = (
    await query(
      `SELECT COALESCE(SUM(amount),0) AS amount, COUNT(*) AS n FROM supplier_returns
        WHERE created_at >= $1 AND created_at < $2`,
      [lo, hi],
    )
  )[0];
  // Кому именно оплачено за период — чтобы видеть это сразу, не открывая каждого.
  const bySupplier = await query(
    `SELECT s.id, s.name,
            COALESCE(SUM(sp.amount),0)                                  AS paid,
            COUNT(*) FILTER (WHERE sp.amount > 0)                       AS payments,
            COALESCE(SUM(sp.amount) FILTER (WHERE sp.source='cash'),0)     AS paid_cash,
            COALESCE(SUM(sp.amount) FILTER (WHERE sp.source='wallet'),0)   AS paid_wallet,
            COALESCE(SUM(sp.amount) FILTER (WHERE sp.source='hand'),0)     AS paid_hand,
            COALESCE(SUM(sp.amount) FILTER (WHERE sp.source='external'),0) AS paid_external
       FROM supplier_payments sp
       JOIN supplier_invoices si ON si.id = sp.invoice_id
       JOIN suppliers s          ON s.id = si.supplier_id
      WHERE sp.created_at >= $1 AND sp.created_at < $2
      GROUP BY s.id, s.name
      ORDER BY paid DESC`,
    [lo, hi],
  );
  // Журнал: каждый платёж за период отдельной строкой — кому, сколько, откуда
  // деньги и кто внёс. Платежи неизменяемы, список только для чтения.
  const journal = await query(
    `SELECT sp.id, sp.created_at, sp.amount, sp.source, sp.note, sp.return_id,
            s.id AS supplier_id, s.name AS supplier_name,
            si.total AS invoice_total, si.created_at AS invoice_at,
            COALESCE(u.full_name, u.username) AS by_user
       FROM supplier_payments sp
       JOIN supplier_invoices si ON si.id = sp.invoice_id
       JOIN suppliers s          ON s.id = si.supplier_id
       LEFT JOIN users u         ON u.id = sp.user_id
      WHERE sp.created_at >= $1 AND sp.created_at < $2
      ORDER BY sp.created_at DESC
      LIMIT 500`,
    [lo, hi],
  );
  // Возвраты товара поставщикам за период — тоже строки журнала (с составом).
  const retList = await query(
    `SELECT r.id, r.created_at, r.amount, r.refund_amount, r.refund_source, r.note,
            s.id AS supplier_id, s.name AS supplier_name,
            COALESCE(u.full_name, u.username) AS by_user,
            COALESCE(
              json_agg(json_build_object('name', ri.name, 'qty', ri.qty) ORDER BY ri.name)
                FILTER (WHERE ri.id IS NOT NULL), '[]'
            ) AS items
       FROM supplier_returns r
       JOIN suppliers s ON s.id = r.supplier_id
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN supplier_return_items ri ON ri.return_id = r.id
      WHERE r.created_at >= $1 AND r.created_at < $2
      GROUP BY r.id, s.id, s.name, u.full_name, u.username
      ORDER BY r.created_at DESC
      LIMIT 200`,
    [lo, hi],
  );
  res.json({
    returns_list: retList.map((r: any) => ({
      id: r.id,
      created_at: r.created_at,
      amount: Number(r.amount),
      refund_amount: Number(r.refund_amount),
      refund_source: r.refund_source,
      note: r.note,
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      by_user: r.by_user,
      items: (r.items ?? []).map((i: any) => ({ name: i.name, qty: Number(i.qty) })),
    })),
    payments_list: journal.map((r: any) => ({
      id: r.id,
      created_at: r.created_at,
      amount: Number(r.amount),
      source: r.source,
      note: r.note,
      return_id: r.return_id,
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      invoice_total: Number(r.invoice_total),
      invoice_at: r.invoice_at,
      by_user: r.by_user,
    })),
    paid: Number(pay.paid),
    paid_cash: Number(pay.paid_cash),
    paid_wallet: Number(pay.paid_wallet),
    paid_hand: Number(pay.paid_hand),
    paid_external: Number(pay.paid_external),
    payments: Number(pay.payments),
    refunded: Number(pay.refunded),
    returned: Number(rets.amount),
    returns: Number(rets.n),
    purchased: Number(inv.purchased),
    invoices: Number(inv.invoices),
    by_supplier: bySupplier.map((r: any) => ({
      id: r.id,
      name: r.name,
      paid: Number(r.paid),
      payments: Number(r.payments),
      paid_cash: Number(r.paid_cash),
      paid_wallet: Number(r.paid_wallet),
      paid_hand: Number(r.paid_hand),
      paid_external: Number(r.paid_external),
    })),
  });
});
