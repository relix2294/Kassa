import { Router } from 'express';
import { query, withTx } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { requireOwner } from '../lib/auth.js';
import { computeAccountable, tillAvailable, tillShortMessage } from './shifts.js';
import { notifySupplierPayment } from '../lib/telegram.js';

// Поставщики и долги (постоплата). Только владелец.
// Модель проста: у поставщика есть накладные (сумма + сколько оплачено),
// долг = сумма − оплачено. Платежи увеличивают «оплачено» и гасят долг.
export const suppliersRouter = Router();

suppliersRouter.use(requireOwner);

type PaySource = 'cash' | 'wallet' | 'hand' | 'external';

// Откуда платим поставщику — выбирают ЯВНО, значения по умолчанию нет (раньше
// без выбора оплата молча становилась «со стороны» и не уменьшала ни кассу, ни
// руки). Проверяем, что деньги там есть, и возвращаем смену для привязки:
//   'cash'/'wallet' — из кассы: открытая смена (чья угодно) или закрытый ящик;
//   'hand'          — с рук (подотчёт): должно хватать «на руках»;
//   'external'      — со стороны (банк/личные деньги): ничего не трогает.
async function checkPaySource(
  rawSource: unknown, amount: number, userId: string,
): Promise<{ ok: true; source: PaySource; shift: any | null } | { ok: false; status: number; error: string }> {
  const source = rawSource as PaySource;
  if (!['cash', 'wallet', 'hand', 'external'].includes(source as string)) {
    return { ok: false, status: 400, error: 'Выберите, откуда деньги: из кассы, с рук (подотчёт) или со стороны' };
  }
  if (source === 'cash' || source === 'wallet') {
    const { avail, shift } = await tillAvailable(source);
    if (amount > avail + 1e-9) {
      return { ok: false, status: 400, error: tillShortMessage(source, avail, amount, shift, 'оплатить') };
    }
    return { ok: true, source, shift };
  }
  if (source === 'hand') {
    const acc = await computeAccountable(userId);
    if (amount > acc.on_hand + 1e-9) {
      return { ok: false, status: 400, error: `На руках только ${acc.on_hand.toFixed(2)} — оплатить ${amount.toFixed(2)} с рук нельзя. Сначала изымите деньги из кассы.` };
    }
  }
  return { ok: true, source, shift: null };
}

// После оплаты: обновить кабинет/смену и сообщить в Telegram (наши деньги).
function afterPayment(source: PaySource, shift: any | null, userId: string, amount: number) {
  if (shift) broadcast('shift', shift);
  else broadcast('data_updated', { kind: 'supplier_payment' });
  if (source !== 'external') void notifySupplierPayment({ userId, amount, source });
}

// Список поставщиков с текущим долгом + общий долг.
suppliersRouter.get('/', async (_req, res) => {
  const rows = await query(
    `SELECT s.id, s.name, s.phone, s.created_at,
            COALESCE(SUM(i.total - i.paid - i.returned), 0) AS debt,
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

// Изменить поставщика: только справочные данные — имя и телефон. Накладные,
// долги и платежи не трогаем (это денежная история, правится своими путями).
suppliersRouter.patch('/:id', async (req, res) => {
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : undefined;
  const phone = req.body?.phone !== undefined ? (String(req.body.phone).trim() || null) : undefined;
  if (name !== undefined && !name) return res.status(400).json({ error: 'Имя поставщика не может быть пустым' });
  if (name === undefined && phone === undefined) return res.status(400).json({ error: 'Нечего менять' });

  const rows = await query(
    `UPDATE suppliers SET name = COALESCE($2, name), phone = COALESCE($3, phone) WHERE id = $1 RETURNING *`,
    [req.params.id, name ?? null, phone === undefined ? null : phone],
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  await writeLog({
    type: 'supplier_update', entity: 'supplier', entityId: req.params.id, userId: req.user!.id,
    details: { name, phone },
  });
  res.json(rows[0]);
});

// Карточка поставщика: накладные (с остатком долга) и платежи.
suppliersRouter.get('/:id', async (req, res) => {
  const s = (await query(`SELECT * FROM suppliers WHERE id = $1`, [req.params.id]))[0];
  if (!s) return res.status(404).json({ error: 'not_found' });
  const invoices = await query(
    `SELECT i.*, (i.total - i.paid - i.returned) AS remaining,
            COALESCE(
              json_agg(json_build_object('id', p.id, 'amount', p.amount, 'note', p.note, 'source', p.source, 'created_at', p.created_at)
                       ORDER BY p.created_at DESC) FILTER (WHERE p.id IS NOT NULL), '[]'
            ) AS payments
       FROM supplier_invoices i
       LEFT JOIN supplier_payments p ON p.invoice_id = i.id
      WHERE i.supplier_id = $1
      GROUP BY i.id
      ORDER BY (i.total - i.paid - i.returned) DESC, i.created_at DESC`,
    [req.params.id],
  );
  const debt = invoices.reduce((sum: number, i: any) => sum + Number(i.remaining), 0);
  // Возвраты товара этому поставщику — с составом.
  const returns = await query(
    `SELECT r.id, r.invoice_id, r.amount, r.refund_amount, r.refund_source, r.note, r.created_at,
            COALESCE(u.full_name, u.username) AS by_user,
            COALESCE(
              json_agg(json_build_object('name', ri.name, 'qty', ri.qty, 'unit_cost', ri.unit_cost)
                       ORDER BY ri.name) FILTER (WHERE ri.id IS NOT NULL), '[]'
            ) AS items
       FROM supplier_returns r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN supplier_return_items ri ON ri.return_id = r.id
      WHERE r.supplier_id = $1
      GROUP BY r.id, u.full_name, u.username
      ORDER BY r.created_at DESC`,
    [req.params.id],
  );
  res.json({ supplier: s, invoices, returns, debt: Number(debt.toFixed(2)) });
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

  // «Оплатили сразу» — это настоящий платёж: откуда деньги, выбирают явно.
  let pay: { source: PaySource; shift: any | null } | null = null;
  if (paid > 0) {
    const chk = await checkPaySource(req.body?.source, paid, req.user!.id);
    if (!chk.ok) return res.status(chk.status).json({ error: chk.error });
    pay = { source: chk.source, shift: chk.shift };
  }

  const result = await withTx(async (client) => {
    const inv = (
      await client.query(
        `INSERT INTO supplier_invoices (supplier_id, total, paid, note, user_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id, total, paid, note, req.user!.id],
      )
    ).rows[0];
    // Стартовую оплату тоже фиксируем как платёж — для истории.
    if (pay) {
      await client.query(
        `INSERT INTO supplier_payments (invoice_id, amount, note, source, shift_id, user_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [inv.id, paid, 'оплата при поставке', pay.source, pay.shift?.id ?? null, req.user!.id],
      );
    }
    await writeLog(
      { type: 'supplier_invoice', entity: 'supplier', entityId: req.params.id, userId: req.user!.id,
        details: { total, paid, debt: Number((total - paid).toFixed(2)), source: pay?.source } },
      client,
    );
    return inv;
  });
  if (pay) afterPayment(pay.source, pay.shift, req.user!.id, paid);
  res.status(201).json(result);
});

// Внести платёж по накладной — гасит долг.
// source: 'cash'/'wallet' — заплатили ИЗ КАССЫ (уменьшает смену, нужна сверка)
//         'hand'          — из подотчёта (из изъятых на руки денег): кассу не
//                           трогает, уменьшает подотчёт сотрудника.
//         'external'      — со стороны (банк/перевод), кассу не трогает.
suppliersRouter.post('/invoices/:invoiceId/payments', async (req, res) => {
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note ?? '').trim() || null;
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма платежа должна быть больше нуля' });

  const chk = await checkPaySource(req.body?.source, amount, req.user!.id);
  if (!chk.ok) return res.status(chk.status).json({ error: chk.error });
  const { source, shift } = chk;

  try {
    const result = await withTx(async (client) => {
      const inv = (await client.query(`SELECT * FROM supplier_invoices WHERE id = $1 FOR UPDATE`, [req.params.invoiceId])).rows[0];
      if (!inv) throw { status: 404, message: 'Накладная не найдена' };
      const remaining = Number(inv.total) - Number(inv.paid) - Number(inv.returned);
      if (amount > remaining + 1e-9) {
        throw { status: 400, message: `По накладной осталось ${remaining.toFixed(2)} — платёж ${amount.toFixed(2)} больше долга` };
      }
      const upd = (
        await client.query(`UPDATE supplier_invoices SET paid = paid + $2 WHERE id = $1 RETURNING *`, [inv.id, amount])
      ).rows[0];
      const pay = (
        await client.query(
          `INSERT INTO supplier_payments (invoice_id, amount, note, source, shift_id, user_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [inv.id, amount, note, source, shift?.id ?? null, req.user!.id],
        )
      ).rows[0];
      await writeLog(
        { type: 'supplier_payment', entity: 'supplier', entityId: inv.supplier_id, userId: req.user!.id,
          details: {
            amount, source,
            from_till: source === 'cash' || source === 'wallet' || undefined,
            from_hand: source === 'hand' || undefined,
            remaining: Number((Number(upd.total) - Number(upd.paid) - Number(upd.returned)).toFixed(2)),
          } },
        client,
      );
      return { invoice: upd, payment: pay };
    });
    afterPayment(source, shift, req.user!.id, amount);
    res.status(201).json(result);
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

// Вернуть товар поставщику (поставка не пошла, отдаём назад).
// Тело: { items: [{ product_id, qty }], amount, note, refund_source? }
//   items         — что возвращаем (товар уходит со склада, это НЕ потеря/списание);
//   amount        — на какую сумму поставщик засчитывает возврат (по умолчанию
//                   владелец вводит её сам: может отличаться от нашей себестоимости);
//   refund_source — нужен, только если засчитанная сумма больше текущего долга по
//                   накладной, т.е. часть уже была оплачена и поставщик возвращает
//                   нам деньги: в кассу (cash/wallet), на руки (hand) или мимо
//                   кассы (external). Откуда-то «по умолчанию» нет — выбирают явно.
// Накладная и её платежи не правятся: возврат — новая запись, долг считается
// как total − paid − returned.
suppliersRouter.post('/invoices/:invoiceId/returns', async (req, res) => {
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note ?? '').trim() || null;
  const rawItems: any[] = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!(amount > 0)) return res.status(400).json({ error: 'Сумма возврата должна быть больше нуля' });
  const items = rawItems
    .map((i) => ({ product_id: String(i?.product_id ?? ''), qty: Number(i?.qty) }))
    .filter((i) => i.product_id);
  if (items.some((i) => !(i.qty > 0))) return res.status(400).json({ error: 'У каждого товара количество должно быть больше нуля' });
  if (new Set(items.map((i) => i.product_id)).size !== items.length) {
    return res.status(400).json({ error: 'Один и тот же товар указан дважды' });
  }

  // Заранее смотрим накладную, чтобы понять, нужен ли возврат денег и куда.
  const pre = (await query(`SELECT * FROM supplier_invoices WHERE id = $1`, [req.params.invoiceId]))[0];
  if (!pre) return res.status(404).json({ error: 'Накладная не найдена' });
  const preDebt = Number(pre.total) - Number(pre.paid) - Number(pre.returned);
  const needRefund = amount > preDebt + 1e-9;
  let refundSource: PaySource | null = null;
  let refundShift: any | null = null;
  if (needRefund) {
    const src = req.body?.refund_source as PaySource;
    if (!['cash', 'wallet', 'hand', 'external'].includes(src as string)) {
      return res.status(400).json({
        error: `Часть накладной уже оплачена — поставщик возвращает деньги. Выберите, куда они пришли: в кассу, на руки или мимо кассы`,
      });
    }
    refundSource = src;
    // В кассу деньги приходят в открытую смену (чью угодно) или в закрытый ящик.
    if (src === 'cash' || src === 'wallet') refundShift = (await tillAvailable(src)).shift;
  }

  try {
    const result = await withTx(async (client) => {
      const inv = (await client.query(`SELECT * FROM supplier_invoices WHERE id = $1 FOR UPDATE`, [req.params.invoiceId])).rows[0];
      if (!inv) throw { status: 404, message: 'Накладная не найдена' };
      const total = Number(inv.total);
      const paid = Number(inv.paid);
      const returned = Number(inv.returned);
      if (amount > total - returned + 1e-9) {
        throw { status: 400, message: `По накладной можно вернуть не больше ${(total - returned).toFixed(2)} (уже возвращено ${returned.toFixed(2)})` };
      }
      const debt = total - paid - returned;
      const refund = Number(Math.max(0, amount - debt).toFixed(2)); // сколько денег вернёт поставщик
      if ((refund > 0) !== needRefund) throw { status: 409, message: 'Накладная изменилась — откройте её заново' };

      const ret = (
        await client.query(
          `INSERT INTO supplier_returns (invoice_id, supplier_id, amount, refund_amount, refund_source, note, user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [inv.id, inv.supplier_id, amount, refund, refund > 0 ? refundSource : null, note, req.user!.id],
        )
      ).rows[0];

      const touched: any[] = [];
      for (const it of items) {
        const p = (await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [it.product_id])).rows[0];
        if (!p) throw { status: 400, message: 'Товар не найден' };
        if (Number(p.stock) < it.qty - 1e-9) {
          throw { status: 400, message: `«${p.name}»: на складе только ${Number(p.stock)} — вернуть ${it.qty} нельзя` };
        }
        // Остаток уменьшается по средней себестоимости — сама средняя не меняется.
        const upd = (
          await client.query(`UPDATE products SET stock = stock - $2, updated_at = now() WHERE id = $1 RETURNING *`, [p.id, it.qty])
        ).rows[0];
        await client.query(
          `INSERT INTO supplier_return_items (return_id, product_id, name, qty, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
          [ret.id, p.id, p.name, it.qty, Number(p.cost_price)],
        );
        touched.push(upd);
      }

      // Накладная: возвращено растёт; если часть уже оплачена — на эту часть
      // «оплачено» уменьшается (деньги вернулись), долг не уходит в минус.
      const upd = (
        await client.query(
          `UPDATE supplier_invoices SET returned = returned + $2, paid = paid - $3 WHERE id = $1 RETURNING *`,
          [inv.id, amount, refund],
        )
      ).rows[0];

      // Деньги, вернувшиеся от поставщика, — платёж с МИНУСОМ: расчёты кассы,
      // подотчёта и ленты считают его сами (как внесение в кассу).
      if (refund > 0) {
        await client.query(
          `INSERT INTO supplier_payments (invoice_id, amount, note, source, shift_id, user_id, return_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [inv.id, -refund, note ? `возврат поставщику: ${note}` : 'возврат поставщику', refundSource, refundShift?.id ?? null, req.user!.id, ret.id],
        );
      }

      await writeLog(
        { type: 'supplier_return', entity: 'supplier', entityId: inv.supplier_id, userId: req.user!.id,
          details: {
            amount, refund, refund_source: refund > 0 ? refundSource : undefined,
            items: items.length, debt_after: Number((Number(upd.total) - Number(upd.paid) - Number(upd.returned)).toFixed(2)),
          } },
        client,
      );
      return { invoice: upd, return: ret, products: touched };
    });
    for (const p of result.products) broadcast('product_upsert', p, 'all');
    if (refundShift) broadcast('shift', refundShift);
    else broadcast('data_updated', { kind: 'supplier_return' });
    res.status(201).json({ invoice: result.invoice, return: result.return });
  } catch (err: any) {
    if (err?.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});
