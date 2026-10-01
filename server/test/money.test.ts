import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  haveDb, resetDb, addProduct, startServer, stopServer, login, api, db,
} from './helpers.ts';

// Тесты денежных путей: продажи, остатки, смены, возвраты, права доступа.
// Нужна ТЕСТОВАЯ база: TEST_DATABASE_URL=postgres://.../kassa_test
// Без неё тесты помечаются пропущенными (а не падают).

if (!haveDb) {
  test('денежные тесты пропущены (нет TEST_DATABASE_URL с «test» в имени)', { skip: true }, () => {});
} else {
  before(startServer);
  after(stopServer);
  beforeEach(resetDb);

  // Открыть смену кассиром на чистой базе (остаток 0/0 — совпадает, без запроса).
  async function openShift(token: string) {
    const r = await api(token, '/shifts/open', 'POST', { opening_cash: 0, opening_wallet: 0 });
    assert.equal(r.status, 201, 'смена должна открыться');
    const cur = await api(token, '/shifts/current');
    return cur.body.shift.id as string;
  }

  test('вход: верный PIN даёт токен, неверный — 401', async () => {
    const tok = await login('owner', '1234');
    assert.ok(tok, 'owner получил токен');
    const bad = await fetch('http://127.0.0.1:4555/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'owner', pin: '0000' }),
    });
    assert.equal(bad.status, 401);
  });

  test('права: кассир не видит разделы владельца', async () => {
    const c = await login('kassir', '5678');
    for (const p of ['/sales', '/sales/history', '/returns', '/dashboard/summary?period=today', '/users', '/analytics/write-offs']) {
      const r = await api(c, p);
      assert.equal(r.status, 403, `кассиру должно быть 403 на ${p}`);
    }
  });

  test('оверселл заблокирован: нельзя продать больше, чем на складе', async () => {
    const c = await login('kassir', '5678');
    const p = await addProduct('Кола', 6, 4, 3, '111');
    const shift = await openShift(c);
    const r = await api(c, '/sales', 'POST', {
      client_id: 'os-1', items: [{ barcode: '111', qty: 99 }],
      payment_method: 'cash', cash_received: 1000, shift_id: shift,
    });
    assert.equal(r.status, 400, 'продажа сверх остатка должна отклоняться');
    const row = await db().query('SELECT stock FROM products WHERE id=$1', [p.id]);
    assert.equal(Number(row.rows[0].stock), 3, 'остаток не изменился');
  });

  test('продажа наличными: сумма верна, остаток списан, дубль не проводится дважды', async () => {
    const c = await login('kassir', '5678');
    const p = await addProduct('Самса', 5, 3, 10, '222');
    const shift = await openShift(c);
    const sale = await api(c, '/sales', 'POST', {
      client_id: 'd-1', items: [{ barcode: '222', qty: 2 }],
      payment_method: 'cash', cash_received: 50, shift_id: shift,
    });
    assert.equal(sale.status, 201);
    assert.equal(Number(sale.body.sale.total), 10, 'итог 2×5=10');
    let row = await db().query('SELECT stock FROM products WHERE id=$1', [p.id]);
    assert.equal(Number(row.rows[0].stock), 8, 'остаток 10−2=8');
    // Повтор того же client_id — идемпотентно, второй продажи нет.
    const dup = await api(c, '/sales', 'POST', {
      client_id: 'd-1', items: [{ barcode: '222', qty: 2 }],
      payment_method: 'cash', cash_received: 50, shift_id: shift,
    });
    assert.equal(dup.body.duplicate, true, 'дубль помечен');
    row = await db().query('SELECT stock FROM products WHERE id=$1', [p.id]);
    assert.equal(Number(row.rows[0].stock), 8, 'остаток не списан повторно');
  });

  test('смена: закрытие без расхождения считает разницу 0', async () => {
    const o = await login('owner', '1234');
    await addProduct('Хлеб', 4, 2, 20, '333');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 's-1', items: [{ barcode: '333', qty: 3 }],
      payment_method: 'cash', cash_received: 12, shift_id: shift,
    });
    const cur = await api(o, '/shifts/current');
    const expCash = cur.body.expected_cash; // 0 размен + 12 продажа = 12
    assert.equal(expCash, 12);
    const closed = await api(o, '/shifts/close', 'POST', { counted_cash: 12, counted_wallet: 0 });
    assert.equal(closed.status, 200);
    assert.equal(Number(closed.body.shift.difference), 0, 'нал без расхождения');
  });

  test('железобетон: кассир не закрывает смену с расхождением — нужен владелец', async () => {
    const c = await login('kassir', '5678');
    const o = await login('owner', '1234');
    await addProduct('Вода', 3, 2, 20, '444');
    const shift = await openShift(c);
    await api(c, '/sales', 'POST', {
      client_id: 'm-1', items: [{ barcode: '444', qty: 2 }],
      payment_method: 'cash', cash_received: 6, shift_id: shift,
    });
    // ожидается 6 наличными, кассир считает 3 — расхождение
    const close = await api(c, '/shifts/close', 'POST', { counted_cash: 3, counted_wallet: 0 });
    assert.equal(close.status, 202, 'кассир сам не закрывает');
    assert.equal(close.body.pending, true);
    // владелец видит запрос и одобряет
    const reqs = await api(o, '/shifts/requests');
    assert.equal(reqs.body.length, 1);
    const appr = await api(o, `/shifts/requests/${reqs.body[0].id}/approve`, 'POST');
    assert.equal(appr.status, 200);
    assert.equal(appr.body.shift.status, 'closed');
    assert.equal(Number(appr.body.shift.difference), -3, 'недостача записана');
  });

  test('возврат: кассир создаёт запрос, владелец одобряет — тогда деньги/склад', async () => {
    const c = await login('kassir', '5678');
    const o = await login('owner', '1234');
    const p = await addProduct('Сок', 10, 6, 5, '555');
    const shift = await openShift(c);
    // продаём 2, чтобы в кассе были наличные на возврат
    await api(c, '/sales', 'POST', {
      client_id: 'r-sale', items: [{ barcode: '555', qty: 2 }],
      payment_method: 'cash', cash_received: 20, shift_id: shift,
    });
    let row = await db().query('SELECT stock FROM products WHERE id=$1', [p.id]);
    assert.equal(Number(row.rows[0].stock), 3);
    // кассир оформляет возврат 1 шт → запрос, без изменений
    const ret = await api(c, '/returns', 'POST', {
      client_id: 'r-1', items: [{ product_id: p.id, qty: 1, unit_price: 10 }],
      reason: 'Брак', shift_id: shift,
    });
    assert.equal(ret.status, 202);
    assert.equal(ret.body.pending, true);
    row = await db().query('SELECT stock FROM products WHERE id=$1', [p.id]);
    assert.equal(Number(row.rows[0].stock), 3, 'до одобрения склад не меняется');
    // владелец одобряет → возврат выполняется
    const reqs = await api(o, '/returns/requests');
    assert.equal(reqs.body.length, 1);
    const appr = await api(o, `/returns/requests/${reqs.body[0].id}/approve`, 'POST');
    assert.equal(appr.status, 200);
    row = await db().query('SELECT stock FROM products WHERE id=$1', [p.id]);
    assert.equal(Number(row.rows[0].stock), 4, 'после одобрения товар вернулся на склад');
  });

  test('возврат: владелец отклоняет — ничего не меняется', async () => {
    const c = await login('kassir', '5678');
    const o = await login('owner', '1234');
    const p = await addProduct('Чай', 8, 5, 5, '666');
    const shift = await openShift(c);
    await api(c, '/sales', 'POST', {
      client_id: 't-sale', items: [{ barcode: '666', qty: 1 }],
      payment_method: 'cash', cash_received: 8, shift_id: shift,
    });
    await api(c, '/returns', 'POST', {
      client_id: 't-ret', items: [{ product_id: p.id, qty: 1, unit_price: 8 }],
      reason: 'Передумал', shift_id: shift,
    });
    const reqs = await api(o, '/returns/requests');
    const rej = await api(o, `/returns/requests/${reqs.body[0].id}/reject`, 'POST');
    assert.equal(rej.status, 200);
    const row = await db().query('SELECT stock FROM products WHERE id=$1', [p.id]);
    assert.equal(Number(row.rows[0].stock), 4, 'после продажи 5−1=4, возврат отклонён — без изменений');
    const rets = await db().query('SELECT count(*) AS n FROM returns');
    assert.equal(Number(rets.rows[0].n), 0, 'возврат не создан');
  });
}
