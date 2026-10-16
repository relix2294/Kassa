import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  haveDb, resetDb, addProduct, startServer, stopServer, login, api, db, BASE,
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
    const bad = await fetch(`${BASE}/auth/login`, {
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

  test('расход кассира: до одобрения касса не меняется, после — уменьшается', async () => {
    const c = await login('kassir', '5678');
    const o = await login('owner', '1234');
    await addProduct('Печенье', 10, 6, 10, '777');
    const shift = await openShift(c);
    // продаём на 30 наличными, чтобы было из чего платить расход
    await api(c, '/sales', 'POST', {
      client_id: 'e-sale', items: [{ barcode: '777', qty: 3 }],
      payment_method: 'cash', cash_received: 30, shift_id: shift,
    });
    let cur = await api(c, '/shifts/current');
    assert.equal(cur.body.expected_cash, 30, 'в кассе 30');
    // кассир вносит расход 10 (аренда) → запрос, касса пока 30
    const exp = await api(c, '/expenses', 'POST', { amount: 10, kind: 'cash', category: 'Аренда' });
    assert.equal(exp.status, 202);
    assert.equal(exp.body.pending, true);
    cur = await api(c, '/shifts/current');
    assert.equal(cur.body.expected_cash, 30, 'до одобрения касса не изменилась');
    // владелец одобряет → касса стала 20
    const reqs = await api(o, '/expenses/requests');
    assert.equal(reqs.body.length, 1);
    const appr = await api(o, `/expenses/requests/${reqs.body[0].id}/approve`, 'POST');
    assert.equal(appr.status, 200);
    cur = await api(c, '/shifts/current');
    assert.equal(cur.body.expected_cash, 20, 'после одобрения 30−10=20');
  });

  test('расход: владелец вносит сам — сразу одобрен и уменьшает кассу', async () => {
    const o = await login('owner', '1234');
    await addProduct('Сахар', 12, 8, 10, '888');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'e2-sale', items: [{ barcode: '888', qty: 2 }],
      payment_method: 'cash', cash_received: 24, shift_id: shift,
    });
    const r = await api(o, '/expenses', 'POST', { amount: 15, kind: 'cash', category: 'Электричество', paid_from: 'register' });
    assert.equal(r.status, 201, 'владелец — сразу одобрено');
    const cur = await api(o, '/shifts/current');
    assert.equal(cur.body.expected_cash, 9, '24−15=9');
  });

  test('расход: нельзя потратить больше, чем в кассе', async () => {
    const o = await login('owner', '1234');
    await addProduct('Соль', 5, 3, 10, '999');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'e3-sale', items: [{ barcode: '999', qty: 1 }],
      payment_method: 'cash', cash_received: 5, shift_id: shift,
    });
    const r = await api(o, '/expenses', 'POST', { amount: 100, kind: 'cash', category: 'Прочее', paid_from: 'register' });
    assert.equal(r.status, 400, 'расход больше кассы отклоняется');
    assert.match(r.body.error, /только 5\.00/, 'отказ именно из-за остатка в кассе');
  });

  test('оплата поставщику из кассы уменьшает кассу; со стороны — не трогает', async () => {
    const o = await login('owner', '1234');
    await addProduct('Кефир', 10, 6, 10, 'sup1');
    const shift = await openShift(o);
    // продаём на 40 наличными
    await api(o, '/sales', 'POST', {
      client_id: 'sp-sale', items: [{ barcode: 'sup1', qty: 4 }],
      payment_method: 'cash', cash_received: 40, shift_id: shift,
    });
    let cur = await api(o, '/shifts/current');
    assert.equal(cur.body.expected_cash, 40);

    // поставщик + накладная с долгом 100
    const sup = await api(o, '/suppliers', 'POST', { name: 'Молзавод' });
    const inv = await api(o, `/suppliers/${sup.body.id}/invoices`, 'POST', { total: 100, paid: 0 });

    // платёж 15 ИЗ КАССЫ наличными → касса 40−15=25
    const p1 = await api(o, `/suppliers/invoices/${inv.body.id}/payments`, 'POST', { amount: 15, source: 'cash' });
    assert.equal(p1.status, 201);
    cur = await api(o, '/shifts/current');
    assert.equal(cur.body.expected_cash, 25, 'из кассы уменьшает ожидаемый остаток');

    // платёж 50 СО СТОРОНЫ → касса не меняется (25)
    const p2 = await api(o, `/suppliers/invoices/${inv.body.id}/payments`, 'POST', { amount: 50, source: 'external' });
    assert.equal(p2.status, 201);
    cur = await api(o, '/shifts/current');
    assert.equal(cur.body.expected_cash, 25, 'со стороны кассу не трогает');

    // нельзя заплатить из кассы больше, чем в ней есть (осталось 25)
    const p3 = await api(o, `/suppliers/invoices/${inv.body.id}/payments`, 'POST', { amount: 30, source: 'cash' });
    assert.equal(p3.status, 400, 'из кассы нельзя больше остатка');

    // долг: 100 − 15 − 50 = 35
    const det = await api(o, `/suppliers/${sup.body.id}`);
    assert.equal(Number(det.body.debt), 35);
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

  // --- Баланс и подотчёт («на руках») ---
  // Ключевое требование владельца: расход «из подотчёта» не считается дважды
  // (и из кассы, и с рук), а общие деньги = касса + подотчёт — сохраняются.

  test('баланс: изъятие уводит деньги из кассы на руки, общий баланс сохраняется', async () => {
    const o = await login('owner', '1234');
    await addProduct('Кола', 100, 60, 10, 'B1');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'b1-sale', items: [{ barcode: 'B1', qty: 5 }],
      payment_method: 'cash', cash_received: 500, shift_id: shift,
    });
    const wd = await api(o, '/shifts/withdraw', 'POST', { amount: 200, kind: 'cash' });
    assert.equal(wd.status, 201);
    const b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 300, 'в кассе 500−200=300');
    assert.equal(b.hands_total, 200, 'на руках 200');
    assert.equal(b.total_cash, 500, 'всего денег не изменилось: 300+200=500');
    assert.equal(b.hands[0].on_hand, 200);
  });

  test('баланс: расход из подотчёта не трогает кассу и не считается дважды', async () => {
    const o = await login('owner', '1234');
    await addProduct('Кола', 100, 60, 10, 'B2');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'b2-sale', items: [{ barcode: 'B2', qty: 5 }],
      payment_method: 'cash', cash_received: 500, shift_id: shift,
    });
    await api(o, '/shifts/withdraw', 'POST', { amount: 200, kind: 'cash' });

    const ex = await api(o, '/expenses', 'POST', { amount: 50, kind: 'cash', category: 'Электричество', paid_from: 'hand' });
    assert.equal(ex.status, 201);
    let b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 300, 'касса не тронута расходом из подотчёта');
    assert.equal(b.hands_total, 150, 'на руках 200−50=150');
    assert.equal(b.total_cash, 450, 'всего 300+150=450 (потратили 50)');
    assert.equal(b.today.expenses_hand, 50);

    const ex2 = await api(o, '/expenses', 'POST', { amount: 30, kind: 'cash', category: 'Вода', paid_from: 'register' });
    assert.equal(ex2.status, 201);
    b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 270, 'касса 300−30=270');
    assert.equal(b.hands_total, 150, 'подотчёт не изменился');
    assert.equal(b.total_cash, 420, 'всего 270+150=420');
    assert.equal(b.today.expenses_register, 30);
  });

  test('баланс: оплата поставщику из подотчёта гасит долг и уменьшает руки, кассу не трогает', async () => {
    const o = await login('owner', '1234');
    await addProduct('Кола', 100, 60, 10, 'B3');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'b3-sale', items: [{ barcode: 'B3', qty: 5 }],
      payment_method: 'cash', cash_received: 500, shift_id: shift,
    });
    await api(o, '/shifts/withdraw', 'POST', { amount: 200, kind: 'cash' });

    const sup = await api(o, '/suppliers', 'POST', { name: 'Оптбаза' });
    const inv = await api(o, `/suppliers/${sup.body.id}/invoices`, 'POST', { total: 100, paid: 0 });
    const pay = await api(o, `/suppliers/invoices/${inv.body.id}/payments`, 'POST', { amount: 40, source: 'hand' });
    assert.equal(pay.status, 201);

    const b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 300, 'касса не тронута оплатой из подотчёта');
    assert.equal(b.hands_total, 160, 'на руках 200−40=160');
    assert.equal(b.supplier_debt, 60, 'долг 100−40=60');
    assert.equal(b.total_cash, 460, 'всего 300+160=460');
    assert.equal(b.today.supplier_hand, 40);
  });

  test('баланс: нельзя потратить из подотчёта больше, чем на руках', async () => {
    const o = await login('owner', '1234');
    await addProduct('Кола', 100, 60, 10, 'B4');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'b4-sale', items: [{ barcode: 'B4', qty: 5 }],
      payment_method: 'cash', cash_received: 500, shift_id: shift,
    });
    await api(o, '/shifts/withdraw', 'POST', { amount: 100, kind: 'cash' });
    const ex = await api(o, '/expenses', 'POST', { amount: 150, kind: 'cash', category: 'Прочее', paid_from: 'hand' });
    assert.equal(ex.status, 400, 'нельзя уйти в минус по подотчёту');
  });

  test('баланс: без открытой смены касса = остаток последней закрытой', async () => {
    const o = await login('owner', '1234');
    await addProduct('Кола', 100, 60, 10, 'B5');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'b5-sale', items: [{ barcode: 'B5', qty: 3 }],
      payment_method: 'cash', cash_received: 300, shift_id: shift,
    });
    const closed = await api(o, '/shifts/close', 'POST', { counted_cash: 300, counted_wallet: 0 });
    assert.equal(closed.status, 200);
    const b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.has_open_shift, false, 'смена закрыта');
    assert.equal(b.till.cash, 300, 'касса = сосчитанный остаток последней смены');
  });

  test('баланс: сверка подотчёта приводит «на руках» к факту', async () => {
    const o = await login('owner', '1234');
    await addProduct('Кола', 100, 60, 10, 'B6');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'b6-sale', items: [{ barcode: 'B6', qty: 5 }],
      payment_method: 'cash', cash_received: 500, shift_id: shift,
    });
    await api(o, '/shifts/withdraw', 'POST', { amount: 200, kind: 'cash' });

    let b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.hands[0].on_hand, 200, 'на руках 200 до сверки');
    assert.equal(b.total_cash, 500);

    // Фактически на руках осталось 50 (остальное потрачено, но не отмечено).
    const uid = b.hands[0].user_id;
    const adj = await api(o, '/dashboard/accountable/adjust', 'POST', { user_id: uid, on_hand: 50 });
    assert.equal(adj.status, 200);
    assert.equal(adj.body.delta, -150, 'разница −150');

    b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.hands[0].on_hand, 50, 'на руках приведено к 50');
    assert.equal(b.hands[0].adjustments, -150);
    assert.equal(b.total_cash, 350, 'всего = касса 300 + на руках 50');
  });

  test('лента подотчёта: каждое движение видно, остаток совпадает с Кабинетом', async () => {
    const o = await login('owner', '1234');
    await addProduct('Сок', 100, 60, 20, 'B7');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'b7-sale', items: [{ barcode: 'B7', qty: 10 }],
      payment_method: 'cash', cash_received: 1000, shift_id: shift,
    });
    // Изъял 600 себе на руки, сверил остаток до 500.
    await api(o, '/shifts/withdraw', 'POST', { amount: 600, kind: 'cash' });
    const uid = (await api(o, '/dashboard/balance')).body.hands[0].user_id;
    await api(o, '/dashboard/accountable/adjust', 'POST', { user_id: uid, on_hand: 500 });

    // После сверки: ещё изъятие 300, расход с рук 50, расход из кассы 20,
    // оплата поставщику с рук 120, из кассы 30 и «со стороны» 70.
    await api(o, '/shifts/withdraw', 'POST', { amount: 300, kind: 'cash' });
    await api(o, '/expenses', 'POST', { amount: 50, kind: 'cash', category: 'Вода', paid_from: 'hand' });
    await api(o, '/expenses', 'POST', { amount: 20, kind: 'cash', category: 'Пакеты', paid_from: 'register' });
    const sup = await api(o, '/suppliers', 'POST', { name: 'Лента-тест' });
    const inv = await api(o, `/suppliers/${sup.body.id}/invoices`, 'POST', { total: 500, paid: 0 });
    for (const [amount, source] of [[120, 'hand'], [30, 'cash'], [70, 'external']] as const) {
      const p = await api(o, `/suppliers/invoices/${inv.body.id}/payments`, 'POST', { amount, source });
      assert.equal(p.status, 201, `оплата ${amount} (${source}) принята`);
    }

    const l = (await api(o, '/dashboard/ledger')).body;
    const b = (await api(o, '/dashboard/balance')).body;
    assert.equal(l.on_hand, b.hands_total, 'остаток ленты = «на руках» в Кабинете');
    assert.equal(l.on_hand, 500 + 300 - 50 - 120, 'на руках = 500 + 300 − 50 − 120');

    // Итоги «с последней сверки» — то, что владелец сверяет с фактом.
    assert.equal(l.since.start_balance, 500, 'стартуем с цифры сверки');
    assert.equal(l.since.totals.withdrawn, 300);
    assert.equal(l.since.totals.expenses_hand, 50);
    assert.equal(l.since.totals.expenses_register, 20);
    assert.equal(l.since.totals.supplier_hand, 120);
    assert.equal(l.since.totals.supplier_cash, 30);
    assert.equal(l.since.totals.supplier_external, 70);
    assert.equal(l.since.totals.hand_change, 300 - 50 - 120);

    // Каждая строка показывает, двигала ли она «на руках», и бегущий остаток.
    const ext = l.rows.find((r: any) => r.type === 'supplier' && r.source === 'external');
    assert.equal(ext.hand_effect, 0, '«со стороны» на руки не влияет');
    assert.equal(ext.title, 'Оплата поставщику: Лента-тест');
    assert.equal(l.rows[l.rows.length - 1].balance, l.on_hand, 'последний бегущий остаток = итог');
  });

  test('вечер: смену закрыли, изъяли всё из закрытой кассы — касса 0, утром принимают 0', async () => {
    const o = await login('owner', '1234');
    const c = await login('kassir', '5678');
    await addProduct('Хлеб', 100, 70, 10, 'N1');
    const shift = await openShift(c);
    await api(c, '/sales', 'POST', {
      client_id: 'n1-sale', items: [{ barcode: 'N1', qty: 3 }],
      payment_method: 'cash', cash_received: 300, shift_id: shift,
    });
    const close = await api(c, '/shifts/close', 'POST', { counted_cash: 300, counted_wallet: 0 });
    assert.equal(close.status, 200, 'кассир закрыл без расхождения');

    let b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 300, 'после закрытия деньги лежат в ящике');

    // Изъятие БЕЗ открытия смены — прямо из закрытой кассы.
    const w = await api(o, '/shifts/withdraw', 'POST', { amount: 300, kind: 'cash' });
    assert.equal(w.status, 201, 'изъять из закрытой кассы можно');
    b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 0, 'забрали всё — касса 0');
    assert.equal(b.hands_total, 300, 'деньги на руках');
    assert.equal(b.total_cash, 300, 'всего денег не изменилось');

    const more = await api(o, '/shifts/withdraw', 'POST', { amount: 1, kind: 'cash' });
    assert.equal(more.status, 400, 'из пустой кассы больше не изъять');

    const exp = (await api(c, '/shifts/expected-opening')).body;
    assert.equal(exp.cash, 0, 'утром кассу принимают с 0 — без «фантомных» денег');
  });

  test('касса закрыта и пуста: расход «из кассы» — отказ, «с рук» — проходит', async () => {
    const o = await login('owner', '1234');
    await addProduct('Чай', 100, 70, 10, 'N2');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'n2-sale', items: [{ barcode: 'N2', qty: 2 }],
      payment_method: 'cash', cash_received: 200, shift_id: shift,
    });
    await api(o, '/shifts/close', 'POST', { counted_cash: 200, counted_wallet: 0 });
    await api(o, '/shifts/withdraw', 'POST', { amount: 200, kind: 'cash' });

    const reg = await api(o, '/expenses', 'POST', { amount: 50, kind: 'cash', category: 'Вода', paid_from: 'register' });
    assert.equal(reg.status, 400, 'из пустой закрытой кассы платить нельзя');
    assert.match(reg.body.error, /Смена закрыта/);

    const hand = await api(o, '/expenses', 'POST', { amount: 50, kind: 'cash', category: 'Вода', paid_from: 'hand' });
    assert.equal(hand.status, 201, 'с рук — можно');
    const b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 0, 'касса не тронута');
    assert.equal(b.hands_total, 150, 'на руках 200 − 50');
  });

  test('без явного «откуда деньги» расход и оплата поставщику не проходят', async () => {
    const o = await login('owner', '1234');
    await addProduct('Сахар', 100, 70, 10, 'N3');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'n3-sale', items: [{ barcode: 'N3', qty: 2 }],
      payment_method: 'cash', cash_received: 200, shift_id: shift,
    });
    const ex = await api(o, '/expenses', 'POST', { amount: 10, kind: 'cash', category: 'Прочее' });
    assert.equal(ex.status, 400, 'расход без источника — отказ');
    assert.match(ex.body.error, /откуда деньги/);

    const sup = await api(o, '/suppliers', 'POST', { name: 'Без-источника' });
    const inv = await api(o, `/suppliers/${sup.body.id}/invoices`, 'POST', { total: 100, paid: 0 });
    const p = await api(o, `/suppliers/invoices/${inv.body.id}/payments`, 'POST', { amount: 10 });
    assert.equal(p.status, 400, 'оплата без источника — отказ (раньше молча «со стороны»)');

    const inv2 = await api(o, `/suppliers/${sup.body.id}/invoices`, 'POST', { total: 100, paid: 30 });
    assert.equal(inv2.status, 400, '«оплатили сразу» без источника — отказ');
    const inv3 = await api(o, `/suppliers/${sup.body.id}/invoices`, 'POST', { total: 100, paid: 30, source: 'cash' });
    assert.equal(inv3.status, 201, '«оплатили сразу» из кассы — проходит');
    const cur = await api(o, '/shifts/current');
    assert.equal(cur.body.expected_cash, 170, 'и уменьшает кассу: 200 − 30');
  });

  test('расход владельца «из кассы» во время смены кассира уменьшает кассу этой смены', async () => {
    const o = await login('owner', '1234');
    const c = await login('kassir', '5678');
    await addProduct('Масло', 100, 70, 10, 'N4');
    const shift = await openShift(c);
    await api(c, '/sales', 'POST', {
      client_id: 'n4-sale', items: [{ barcode: 'N4', qty: 2 }],
      payment_method: 'cash', cash_received: 200, shift_id: shift,
    });
    const ex = await api(o, '/expenses', 'POST', { amount: 50, kind: 'cash', category: 'Такси', paid_from: 'register' });
    assert.equal(ex.status, 201);
    const cur = await api(c, '/shifts/current');
    assert.equal(cur.body.expected_cash, 150, 'в смене кассира ожидается 200 − 50');
    const close = await api(c, '/shifts/close', 'POST', { counted_cash: 150, counted_wallet: 0 });
    assert.equal(close.status, 200, 'кассир сдаёт 150 — без расхождения');
  });

  test('оплата поставщику и «оплатили сразу» из закрытой кассы и с рук', async () => {
    const o = await login('owner', '1234');
    await addProduct('Мука', 100, 70, 10, 'N5');
    const shift = await openShift(o);
    await api(o, '/sales', 'POST', {
      client_id: 'n5-sale', items: [{ barcode: 'N5', qty: 3 }],
      payment_method: 'cash', cash_received: 300, shift_id: shift,
    });
    await api(o, '/shifts/close', 'POST', { counted_cash: 300, counted_wallet: 0 });
    const sup = await api(o, '/suppliers', 'POST', { name: 'Мельница' });
    const inv = await api(o, `/suppliers/${sup.body.id}/invoices`, 'POST', { total: 500, paid: 0 });

    const p = await api(o, `/suppliers/invoices/${inv.body.id}/payments`, 'POST', { amount: 120, source: 'cash' });
    assert.equal(p.status, 201, 'из закрытой кассы, где 300, — можно');
    let b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 180, 'касса 300 − 120');

    const big = await api(o, `/suppliers/invoices/${inv.body.id}/payments`, 'POST', { amount: 200, source: 'cash' });
    assert.equal(big.status, 400, 'больше, чем в кассе, — нельзя');

    await api(o, '/shifts/withdraw', 'POST', { amount: 180, kind: 'cash' });
    const inv2 = await api(o, `/suppliers/${sup.body.id}/invoices`, 'POST', { total: 100, paid: 40, source: 'hand' });
    assert.equal(inv2.status, 201);
    b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 0);
    assert.equal(b.hands_total, 140, 'на руках 180 − 40 «оплатили сразу» с рук');
  });

  test('утро: размен с рук в закрытую кассу — Эрач принимает без «излишка», на руках меньше', async () => {
    const o = await login('owner', '1234');
    const c = await login('kassir', '5678');
    await addProduct('Соль', 100, 70, 10, 'D1');
    const shift = await openShift(c);
    await api(c, '/sales', 'POST', {
      client_id: 'd1-sale', items: [{ barcode: 'D1', qty: 3 }],
      payment_method: 'cash', cash_received: 300, shift_id: shift,
    });
    await api(c, '/shifts/close', 'POST', { counted_cash: 300, counted_wallet: 0 });
    await api(o, '/shifts/withdraw', 'POST', { amount: 300, kind: 'cash' });

    const tooMuch = await api(o, '/shifts/deposit', 'POST', { amount: 500, kind: 'cash' });
    assert.equal(tooMuch.status, 400, 'больше, чем на руках, внести нельзя');

    const d = await api(o, '/shifts/deposit', 'POST', { amount: 60, kind: 'cash' });
    assert.equal(d.status, 201);
    let b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 60, 'в ящике размен 60');
    assert.equal(b.hands_total, 240, 'на руках 300 − 60');
    assert.equal(b.total_cash, 300, 'всего денег не изменилось');

    const open = await api(c, '/shifts/open', 'POST', { opening_cash: 60, opening_wallet: 0 });
    assert.equal(open.status, 201, 'кассир принимает 60 — сходится, без запроса владельцу');

    const l = (await api(o, '/dashboard/ledger')).body;
    const dep = l.rows.find((r: any) => r.type === 'deposit');
    assert.equal(dep.amount, 60);
    assert.equal(dep.hand_effect, -60, 'размен уменьшает «на руках»');
    assert.equal(l.on_hand, 240);
  });

  test('кассир принял кассу с лишними 60 — владелец одобряет «это размен с моих рук»', async () => {
    const o = await login('owner', '1234');
    const c = await login('kassir', '5678');
    await addProduct('Перец', 100, 70, 10, 'D2');
    const shift = await openShift(c);
    await api(c, '/sales', 'POST', {
      client_id: 'd2-sale', items: [{ barcode: 'D2', qty: 2 }],
      payment_method: 'cash', cash_received: 200, shift_id: shift,
    });
    await api(c, '/shifts/close', 'POST', { counted_cash: 200, counted_wallet: 0 });
    await api(o, '/shifts/withdraw', 'POST', { amount: 200, kind: 'cash' });

    const open = await api(c, '/shifts/open', 'POST', { opening_cash: 60, opening_wallet: 0 });
    assert.equal(open.status, 202, '+60 к пустой кассе — нужен владелец');
    const appr = await api(o, `/shifts/requests/${open.body.request.id}/approve`, 'POST', { as_deposit: true });
    assert.equal(appr.status, 200);
    assert.equal(Number(appr.body.shift.opening_expected), 60, 'смена открыта без расхождения');
    const b = (await api(o, '/dashboard/balance')).body;
    assert.equal(b.till.cash, 60);
    assert.equal(b.hands_total, 140, 'размен 60 ушёл с рук владельца');
  });

  test('двойная отправка одного чека одновременно — проводится один раз', async () => {
    const o = await login('owner', '1234');
    await addProduct('Попкорн', 1, 0.5, 10, 'D3');
    const shift = await openShift(o);
    const body = { client_id: 'same-cart-1', items: [{ barcode: 'D3', qty: 1 }], payment_method: 'cash', cash_received: 1, shift_id: shift };
    const [a, b2] = await Promise.all([api(o, '/sales', 'POST', body), api(o, '/sales', 'POST', body)]);
    assert.ok([200, 201].includes(a.status) && [200, 201].includes(b2.status), `оба ответа успешны: ${a.status}/${b2.status}`);
    assert.equal(a.body.sale.id, b2.body.sale.id, 'это один и тот же чек');
    const cnt = await db().query(`SELECT COUNT(*)::int AS n FROM sales WHERE client_id = 'same-cart-1'`);
    assert.equal(cnt.rows[0].n, 1, 'в базе один чек');
    const st = await db().query(`SELECT stock FROM products WHERE barcode = 'D3'`);
    assert.equal(Number(st.rows[0].stock), 9, 'товар списан один раз');
  });

  test('защита входа: после серии неверных PIN — 429 (не даём перебирать)', async () => {
    const body = JSON.stringify({ username: 'ratelimit_probe', pin: '0000' });
    const hit = () => fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    for (let i = 0; i < 7; i++) {
      const r = await hit();
      assert.equal(r.status, 401, `попытка ${i + 1} — неверный PIN`);
    }
    const blocked = await hit();
    assert.equal(blocked.status, 429, 'после лимита вход временно заблокирован');
  });
}
