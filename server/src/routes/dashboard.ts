import { Router } from 'express';
import { query } from '../db.js';
import { requireOwner } from '../lib/auth.js';

export const dashboardRouter = Router();

// Кабинет владельца — только владелец (кассир не видит выручку и маржу).
dashboardRouter.use(requireOwner);

// Сводка за период: выручка, маржа, чеки, возвраты.
// period: today | week | month | all (или произвольные from/to в ISO)
// Часовой пояс магазина: без него «сегодня» считается по времени сервера,
// и выручка за день съезжает, если сервер в другой зоне (п.27 аудита).
const TZ = process.env.STORE_TIMEZONE || 'Asia/Dushanbe';

function periodClause(period: string): string {
  switch (period) {
    case 'today':
      return `created_at >= date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
    case 'week':
      return `created_at >= now() - interval '7 days'`;
    case 'month':
      return `created_at >= now() - interval '30 days'`;
    default:
      return `true`;
  }
}

dashboardRouter.get('/summary', async (req, res) => {
  const period = String(req.query.period || 'today');
  const where = periodClause(period);

  const sales = (
    await query(
      `SELECT
         COUNT(*)                       AS receipts,
         COALESCE(SUM(total),0)         AS revenue,
         COALESCE(SUM(cost_total),0)    AS cost,
         COALESCE(SUM(total) FILTER (WHERE payment_method='cash'),0) AS cash,
         COALESCE(SUM(total) FILTER (WHERE payment_method='card'),0) AS card
       FROM sales WHERE ${where}`,
    )
  )[0];

  const refunds = (
    await query(`SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total FROM returns WHERE ${where}`)
  )[0];

  const revenue = Number(sales.revenue);
  const cost = Number(sales.cost);
  const refundsTotal = Number(refunds.total);

  res.json({
    period,
    receipts: Number(sales.receipts),
    revenue,                                              // пробито по чекам
    net_revenue: Number((revenue - refundsTotal).toFixed(2)), // за вычетом возвратов
    margin: Number((revenue - cost).toFixed(2)),
    cash: Number(sales.cash),
    card: Number(sales.card),
    refunds_count: Number(refunds.count),
    refunds_total: refundsTotal,
  });
});

// Продажи по часам за сегодня — для мини-графика «продажи сейчас».
dashboardRouter.get('/today-hours', async (_req, res) => {
  const rows = await query(
    `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE '${TZ}')::int AS hour,
            COALESCE(SUM(total),0) AS revenue,
            COUNT(*) AS receipts
       FROM sales
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'
      GROUP BY 1 ORDER BY 1`,
  );
  res.json(rows);
});

// Топ товаров за период (по выручке).
dashboardRouter.get('/top-products', async (req, res) => {
  const period = String(req.query.period || 'today');
  const where = periodClause(period).replace(/created_at/g, 's.created_at');
  const rows = await query(
    `SELECT si.name, si.barcode,
            SUM(si.qty)        AS qty,
            SUM(si.line_total) AS revenue,
            SUM(si.line_total - si.unit_cost * si.qty) AS margin
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
      WHERE ${where}
      GROUP BY si.name, si.barcode
      ORDER BY revenue DESC
      LIMIT 10`,
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
