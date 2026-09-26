import { Router } from 'express';
import { query, withTx } from '../db.js';
import { writeLog } from '../lib/log.js';
import { requireOwner } from '../lib/auth.js';

// Поставщики и долги (постоплата). Только владелец.
// Модель проста: у поставщика есть накладные (сумма + сколько оплачено),
// долг = сумма − оплачено. Платежи увеличивают «оплачено» и гасят долг.
export const suppliersRouter = Router();

suppliersRouter.use(requireOwner);

// Список поставщиков с текущим долгом + общий долг.
suppliersRouter.get('/', async (_req, res) => {
  const rows = await query(
    `SELECT s.id, s.name, s.phone, s.created_at,
            COALESCE(SUM(i.total - i.paid), 0) AS debt,
            COUNT(i.id) AS invoices
       FROM suppliers s
       LEFT JOIN supplier_invoices i ON i.supplier_id = s.id
      GROUP BY s.id
      ORDER BY debt DESC, s.name`,
  );
  const totalDebt = rows.reduce((s: number, r: any) => s + Number(r.debt), 0);
  res.json({ suppliers: rows, total_debt: Number(totalDebt.toFixed(2)) });
});

// Завести поставщика.
suppliersRouter.post('/', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const phone = String(req.body?.phone ?? '').trim() || null;
  if (!name) return res.status(400).json({ error: 'Укажите имя поставщика' });
  const row = (await query(`INSERT INTO suppliers (name, phone) VALUES ($1, $2) RETURNING *`, [name, phone]))[0];
  await writeLog({ type: 'supplier_create', entity: 'supplier', entityId: row.id, userId: req.user!.id, details: { name } });
  res.status(201).json(row);
});

// Карточка поставщика: накладные (с остатком долга) и платежи.
suppliersRouter.get('/:id', async (req, res) => {
  const s = (await query(`SELECT * FROM suppliers WHERE id = $1`, [req.params.id]))[0];
  if (!s) return res.status(404).json({ error: 'not_found' });
  const invoices = await query(
    `SELECT i.*, (i.total - i.paid) AS remaining,
            COALESCE(
              json_agg(json_build_object('id', p.id, 'amount', p.amount, 'note', p.note, 'created_at', p.created_at)
                       ORDER BY p.created_at DESC) FILTER (WHERE p.id IS NOT NULL), '[]'
            ) AS payments
       FROM supplier_invoices i
       LEFT JOIN supplier_payments p ON p.invoice_id = i.id
      WHERE i.supplier_id = $1
      GROUP BY i.id
      ORDER BY (i.total - i.paid) DESC, i.created_at DESC`,
    [req.params.id],
  );
  const debt = invoices.reduce((sum: number, i: any) => sum + Number(i.remaining), 0);
  res.json({ supplier: s, invoices, debt: Number(debt.toFixed(2)) });
});

// Добавить накладную (поставку): сумма и сколько оплатили сразу.
suppliersRouter.post('/:id/invoices', async (req, res) => {
  const total = Number(req.body?.total);
  const paid = Number(req.body?.paid) || 0;
  const note = String(req.body?.note ?? '').trim() || null;
  if (!(total > 0)) return res.status(400).json({ error: 'Сумма накладной должна быть больше нуля' });
  if (paid < 0 || paid > total) return res.status(400).json({ error: 'Оплачено не может быть больше суммы накладной' });

  const s = (await query(`SELECT id FROM suppliers WHERE id = $1`, [req.params.id]))[0];
  if (!s) return res.status(404).json({ error: 'not_found' });

  const result = await withTx(async (client) => {
    const inv = (
      await client.query(
        `INSERT INTO supplier_invoices (supplier_id, total, paid, note, user_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id, total, paid, note, req.user!.id],
      )
    ).rows[0];
    // Стартовую оплату тоже фиксируем как платёж — для истории.
    if (paid > 0) {
      await client.query(
        `INSERT INTO supplier_payments (invoice_id, amount, note, user_id) VALUES ($1,$2,$3,$4)`,
        [inv.id, paid, 'оплата при поставке', req.user!.id],
      );
    }
    await writeLog(
      { type: 'supplier_invoice', entity: 'supplier', entityId: req.params.id, userId: req.user!.id,
        details: { total, paid, debt: Number((total - paid).toFixed(2)) } },
      client,
    );
    return inv;
  });
  res.status(201).json(result);
});

// Внести платёж по накладной — гасит долг.
suppliersRouter.post('/invoices/:invoiceId/payments', async (req, res) => {
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note ?? '').trim() || null;
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма платежа должна быть больше нуля' });

  try {
    const result = await withTx(async (client) => {
      const inv = (await client.query(`SELECT * FROM supplier_invoices WHERE id = $1 FOR UPDATE`, [req.params.invoiceId])).rows[0];
      if (!inv) throw { status: 404, message: 'Накладная не найдена' };
      const remaining = Number(inv.total) - Number(inv.paid);
      if (amount > remaining + 1e-9) {
        throw { status: 400, message: `По накладной осталось ${remaining.toFixed(2)} — платёж ${amount.toFixed(2)} больше долга` };
      }
      const upd = (
        await client.query(`UPDATE supplier_invoices SET paid = paid + $2 WHERE id = $1 RETURNING *`, [inv.id, amount])
      ).rows[0];
      const pay = (
        await client.query(
          `INSERT INTO supplier_payments (invoice_id, amount, note, user_id) VALUES ($1,$2,$3,$4) RETURNING *`,
          [inv.id, amount, note, req.user!.id],
        )
      ).rows[0];
      await writeLog(
        { type: 'supplier_payment', entity: 'supplier', entityId: inv.supplier_id, userId: req.user!.id,
          details: { amount, remaining: Number((Number(upd.total) - Number(upd.paid)).toFixed(2)) } },
        client,
      );
      return { invoice: upd, payment: pay };
    });
    res.status(201).json(result);
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
