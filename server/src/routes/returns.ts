import { Router } from 'express';
import { query, withTx } from '../db.js';
import { writeLog } from '../lib/log.js';
import { broadcast } from '../lib/realtime.js';
import { getOpenShift, recomputeClosedShift } from './shifts.js';
import { requireOwner } from '../lib/auth.js';

export const returnsRouter = Router();

// Список возвратов с позициями — только владелец.
// Возврат идёт без чека, поэтому это главный контроль: владелец должен
// видеть каждый возврат целиком (кто, что, сколько, почему).
returnsRouter.get('/', requireOwner, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = await query(
    `SELECT r.id, r.total, r.reason, r.created_at,
            u.username, u.full_name,
            COALESCE(
              json_agg(
                json_build_object('name', ri.name, 'qty', ri.qty, 'line_total', ri.line_total)
                ORDER BY ri.name
              ) FILTER (WHERE ri.id IS NOT NULL), '[]'
            ) AS items
       FROM returns r
       LEFT JOIN users u ON u.id = r.user_id
       LEFT JOIN return_items ri ON ri.return_id = r.id
      GROUP BY r.id, u.username, u.full_name
      ORDER BY r.created_at DESC
      LIMIT $1`,
    [limit],
  );
  res.json(rows);
});

// Выполнить возврат: товар на склад, деньги из кассы. Вынесено отдельно, чтобы
// вызывать и напрямую (владелец), и после одобрения запроса кассира.
// Бросает { status, message } при ошибке валидации/нехватке кассы.
async function executeReturn(body: any, userId: string) {
  const { client_id, items, reason, sale_id, shift_id } = body ?? {};

  if (!Array.isArray(items) || items.length === 0) throw { status: 400, message: 'Пустой возврат' };
  if (!reason || String(reason).trim().length < 3) throw { status: 400, message: 'Укажите причину возврата' };

  if (client_id) {
    const existing = await query(`SELECT * FROM returns WHERE client_id = $1`, [client_id]);
    if (existing.length > 0) return { ret: existing[0], duplicate: true, changedProducts: [] as any[] };
  }

  // Возврат — движение денег: привязываем к своей смене, даже если она уже
  // закрыта (возврат мог быть отложен обрывом сети).
  let shift: any = null;
  let lateToClosedShift = false;
  if (shift_id) {
    const rows = await query(`SELECT * FROM shifts WHERE id = $1 AND user_id = $2`, [shift_id, userId]);
    shift = rows[0] ?? null;
    if (!shift) throw { status: 400, message: 'Смена не найдена или чужая' };
    lateToClosedShift = shift.status === 'closed';
  } else {
    shift = await getOpenShift(userId);
    if (!shift) throw { status: 409, message: 'Нет открытой смены' };
  }

  const result = await withTx(async (client) => {
      let total = 0;
      const changedProducts: any[] = [];
      const lineRows: any[] = [];

      for (const item of items) {
        const qty = Number(item.qty);
        if (!(qty > 0)) throw { status: 400, message: 'qty > 0' };

        const found = item.product_id
          ? await client.query(`SELECT * FROM products WHERE id = $1 FOR UPDATE`, [item.product_id])
          : await client.query(`SELECT * FROM products WHERE barcode = $1 FOR UPDATE`, [item.barcode]);
        if (found.rows.length === 0) {
          throw { status: 400, message: `Товар не найден: ${item.barcode ?? item.product_id}` };
        }
        const p = found.rows[0];

        // Цену возврата берём из чека, если передана, иначе текущую цену продажи.
        const unitPrice = item.unit_price != null ? Number(item.unit_price) : Number(p.sale_price);
        const lineTotal = Number((unitPrice * qty).toFixed(2));
        total += lineTotal;

        const upd = await client.query(
          `UPDATE products SET stock = stock + $2, updated_at = now() WHERE id = $1 RETURNING *`,
          [p.id, qty],
        );
        changedProducts.push(upd.rows[0]);
        lineRows.push({ p, qty, unitPrice, lineTotal });
      }

      total = Number(total.toFixed(2));

      // Нельзя выдать наличными больше, чем есть в кассе смены: иначе касса
      // уходит в минус и вечерняя сверка показывает бессмыслицу. В кассе =
      // размен + продажи наличными − уже сделанные возвраты.
      const cashInRow = (
        await client.query(
          `SELECT (SELECT opening_cash FROM shifts WHERE id = $1)
                + COALESCE((SELECT SUM(COALESCE(cash_amount, total)) FROM sales WHERE shift_id = $1), 0)
                - COALESCE((SELECT SUM(total) FROM returns WHERE shift_id = $1), 0) AS cash`,
          [shift.id],
        )
      ).rows[0];
      const available = Number(cashInRow.cash);
      if (total > available + 1e-9) {
        throw {
          status: 400,
          message: `В кассе только ${available.toFixed(2)} — этого не хватает на возврат ${total.toFixed(2)}. Добавьте размен или уменьшите возврат.`,
        };
      }

      const retRow = (
        await client.query(
          `INSERT INTO returns (client_id, sale_id, total, reason, user_id, shift_id)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
          [client_id ?? null, sale_id ?? null, total, reason ?? null, userId ?? null, shift.id],
        )
      ).rows[0];

      for (const l of lineRows) {
        await client.query(
          `INSERT INTO return_items (return_id, product_id, barcode, name, qty, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [retRow.id, l.p.id, l.p.barcode ?? '', l.p.name, l.qty, l.unitPrice, l.lineTotal],
        );
      }

      await writeLog(
        {
          type: 'return',
          entity: 'return',
          entityId: retRow.id,
          userId: userId ?? null,
          details: { total, items: lineRows.length, reason: reason ?? null, approved_by: body.__approved_by ?? undefined },
        },
        client,
      );

      return { ret: retRow, changedProducts, duplicate: false };
    });

    if (lateToClosedShift && !result.duplicate) {
      const updated = await recomputeClosedShift(shift.id);
      await writeLog({
        type: 'late_return', entity: 'shift', entityId: shift.id, userId,
        details: { return_id: result.ret.id, total: result.ret.total, new_difference: updated?.difference },
      });
      if (updated) broadcast('shift', updated);
    }

    result.changedProducts.forEach((p: any) => broadcast('product_upsert', p, 'all'));
    broadcast('return', result.ret);
    return result;
}

// Возврат/обмен. Владелец — сразу. Кассир — только через одобрение владельца:
// возврат это выдача денег из кассы, главный канал краж (пробил → взял нал →
// «вернул»). Поэтому кассир создаёт запрос, а выполняется он после «добро».
returnsRouter.post('/', async (req, res) => {
  const body = req.body ?? {};
  const { client_id, items, reason } = body;
  const user_id = req.user!.id;

  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Пустой возврат' });
  if (!reason || String(reason).trim().length < 3) return res.status(400).json({ error: 'Укажите причину возврата' });

  // Владелец возвращает сам.
  if (req.user!.role === 'owner') {
    try {
      const result = await executeReturn(body, user_id);
      return res.status(result.duplicate ? 200 : 201).json({ ret: result.ret, duplicate: result.duplicate });
    } catch (err: any) {
      if (err?.status) return res.status(err.status).json({ error: err.message });
      console.error('Ошибка возврата:', err);
      return res.status(500).json({ error: 'internal' });
    }
  }

  // Кассир: не выполняем, а создаём запрос владельцу (идемпотентно по client_id).
  if (client_id) {
    const doneRet = await query(`SELECT * FROM returns WHERE client_id = $1`, [client_id]);
    if (doneRet.length > 0) return res.status(200).json({ ret: doneRet[0], duplicate: true });
    const existingReq = await query(`SELECT * FROM return_requests WHERE client_id = $1`, [client_id]);
    if (existingReq.length > 0) return res.status(202).json({ pending: true, request: existingReq[0] });
  }

  const total = Number(
    items.reduce((s: number, it: any) => s + (Number(it.unit_price) || 0) * (Number(it.qty) || 0), 0).toFixed(2),
  );
  const request = (
    await query(
      `INSERT INTO return_requests (user_id, client_id, payload, total, items_count, reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [user_id, client_id ?? null, JSON.stringify(body), total, items.length, String(reason).trim()],
    )
  )[0];
  await writeLog({
    type: 'return_request', entity: 'return_request', entityId: request.id, userId: user_id,
    details: { total, items: items.length, reason: String(reason).trim() },
  });
  broadcast('return_request', { id: request.id });
  return res.status(202).json({
    pending: true,
    request,
    message: `Возврат на ${total} отправлен владельцу на подтверждение. Позвоните владельцу — он подтвердит из кабинета.`,
  });
});

// Кассир: статус своего последнего запроса на возврат (экран ожидания).
returnsRouter.get('/my-request', async (req, res) => {
  const rows = await query(
    `SELECT * FROM return_requests
      WHERE user_id = $1 AND (status = 'pending' OR resolved_at > now() - interval '10 minutes')
      ORDER BY created_at DESC LIMIT 1`,
    [req.user!.id],
  );
  res.json({ request: rows[0] ?? null });
});

// Кассир: отменить свой запрос на возврат.
returnsRouter.post('/requests/:id/cancel', async (req, res) => {
  const rows = await query(
    `UPDATE return_requests SET status='cancelled', resolved_at=now()
      WHERE id=$1 AND user_id=$2 AND status='pending' RETURNING *`,
    [req.params.id, req.user!.id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  broadcast('return_request', { id: rows[0].id });
  res.json({ ok: true });
});

// Владелец: запросы на возврат, ожидающие подтверждения (с составом).
returnsRouter.get('/requests', requireOwner, async (_req, res) => {
  const rows = await query(
    `SELECT r.*, u.username, u.full_name
       FROM return_requests r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'pending' ORDER BY r.created_at`,
  );
  res.json(rows);
});

// Владелец: дать «добро» — выполнить возврат от имени кассира.
returnsRouter.post('/requests/:id/approve', requireOwner, async (req, res) => {
  const reqRows = await query(`SELECT * FROM return_requests WHERE id=$1`, [req.params.id]);
  const r = reqRows[0];
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.status !== 'pending') return res.status(409).json({ error: 'already_resolved', status: r.status });

  try {
    const payload = { ...r.payload, __approved_by: { id: req.user!.id, username: req.user!.username } };
    const result = await executeReturn(payload, r.user_id);
    await query(
      `UPDATE return_requests SET status='approved', resolved_by=$2, resolved_at=now(), result_return_id=$3 WHERE id=$1`,
      [r.id, req.user!.id, result.ret.id],
    );
    broadcast('return_request', { id: r.id });
    res.json({ ok: true, ret: result.ret });
  } catch (err: any) {
    // Возврат не прошёл (напр. в кассе не хватает наличных) — запрос оставляем
    // в ожидании, чтобы владелец мог разобраться и повторить или отклонить.
    if (err?.status) return res.status(err.status).json({ error: err.message });
    console.error('Ошибка возврата (approve):', err);
    res.status(500).json({ error: 'internal' });
  }
});

// Владелец: отклонить запрос на возврат.
returnsRouter.post('/requests/:id/reject', requireOwner, async (req, res) => {
  const rows = await query(
    `UPDATE return_requests SET status='rejected', resolved_by=$2, resolved_at=now()
      WHERE id=$1 AND status='pending' RETURNING *`,
    [req.params.id, req.user!.id],
  );
  if (!rows[0]) return res.status(404).json({ error: 'not_found_or_resolved' });
  await writeLog({
    type: 'return_request_rejected', entity: 'return_request', entityId: rows[0].id, userId: req.user!.id,
    details: { total: rows[0].total, cashier_id: rows[0].user_id },
  });
  broadcast('return_request', { id: rows[0].id });
  res.json({ ok: true });
});
