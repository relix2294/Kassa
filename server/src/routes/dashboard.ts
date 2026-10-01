import { Router } from 'express';
import { query } from '../db.js';
import { requireOwner } from '../lib/auth.js';

export const dashboardRouter = Router();

// Кабинет владельца — только владелец (кассир не видит выручку и маржу).
dashboardRouter.use(requireOwner);

// Часовой пояс магазина: без него «сегодня» считается по времени сервера и
// выручка за день съезжает, если сервер в другой зоне (п.27 аудита).
const TZ = process.env.STORE_TIMEZONE || 'Asia/Dushanbe';

// Начало сегодняшнего дня в зоне магазина (как timestamptz).
const TODAY = `date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
const TOMORROW = `(${TODAY} + interval '1 day')`;

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

  const revenue = Number(cur.revenue);
  const cost = Number(cur.cost);
  const margin = Number((revenue - cost).toFixed(2));
  const receipts = Number(cur.receipts);
  const refundsTotal = Number(refunds.total);
  const prevRevenue = Number(prev.revenue);
  const prevMargin = Number((Number(prev.revenue) - Number(prev.cost)).toFixed(2));

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
