// Telegram-уведомления для владельца: итоги дня в группу по расписанию и
// мгновенное предупреждение, когда остаток товара падает ниже порога.
//
// Настройки — в переменных окружения (server/.env):
//   TELEGRAM_BOT_TOKEN           токен бота от @BotFather (без него — молчит);
//   TELEGRAM_CHAT_ID             id группы/чата (узнать: npm run tg:chatid);
//   TELEGRAM_DAILY_TIME          когда слать итоги дня, ЧЧ:ММ (по умолч. 12:00);
//   TELEGRAM_LOW_STOCK_THRESHOLD порог низкого остатка (по умолч. 4);
//   STORE_TIMEZONE               зона магазина (по умолч. Asia/Dushanbe).
//
// Если токен или chat_id не заданы — модуль ничего не шлёт и не мешает работе.

import { query } from '../db.js';
import { getCurrentTill, getAnyOpenShift } from '../routes/shifts.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TZ = process.env.STORE_TIMEZONE || 'Asia/Dushanbe';
// Основной «итог» приходит при закрытии смены (моментально). Фиксированное
// время — опционально: задайте TELEGRAM_DAILY_TIME (ЧЧ:ММ) для доп. отчёта.
const DAILY_TIME = process.env.TELEGRAM_DAILY_TIME || '';
export const LOW_STOCK_THRESHOLD = Number(process.env.TELEGRAM_LOW_STOCK_THRESHOLD || 4);

export function telegramEnabled(): boolean {
  return Boolean(TOKEN && CHAT_ID);
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const fmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const money = (n: unknown) => fmt.format(Number(n) || 0);
const unitOf = (u: string) => (u === 'kg' ? 'кг' : 'шт');

// Отправка сообщения в конкретный чат. Никогда не бросает — сеть/Telegram могут
// лежать, касса из-за этого падать не должна. Возвращает true при успехе.
// Превратить HTML-сообщение в обычный текст (на случай, если Telegram не смог
// разобрать разметку): убрать теги и вернуть экранированные символы.
function toPlain(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function postMessage(chatId: string, text: string, html: boolean): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    return await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(html ? { parse_mode: 'HTML' } : {}),
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function sendMessageTo(chatId: string, text: string): Promise<boolean> {
  if (!TOKEN) return false;
  try {
    const res = await postMessage(chatId, text, true);
    if (res.ok) return true;
    const body = await res.text().catch(() => '');
    console.error(`Telegram sendMessage ${res.status}: ${body.slice(0, 200)}`);
    // Телеграм не смог разобрать HTML-разметку — повторяем обычным текстом,
    // чтобы ошибка форматирования не приводила к полному молчанию.
    if (res.status === 400 && /parse entities/i.test(body)) {
      const res2 = await postMessage(chatId, toPlain(text), false);
      if (res2.ok) { console.log('Telegram: сообщение отправлено обычным текстом (разметка отклонена).'); return true; }
      const body2 = await res2.text().catch(() => '');
      console.error(`Telegram sendMessage (plain) ${res2.status}: ${body2.slice(0, 200)}`);
    }
    return false;
  } catch (err: any) {
    console.error('Telegram: не удалось отправить сообщение:', err?.message || err);
    return false;
  }
}

// Отправка в основной чат магазина (группа владельца).
export async function sendTelegram(text: string): Promise<boolean> {
  if (!telegramEnabled()) return false;
  return sendMessageTo(CHAT_ID, text);
}

// --- Низкий остаток: предупреждение при падении ниже порога ---
// Шлём только на «пересечении» порога вниз (было >= порога, стало < порога),
// иначе каждая следующая продажа того же товара спамила бы группу.
export function crossedLowStock(oldStock: number, newStock: number): boolean {
  const t = LOW_STOCK_THRESHOLD;
  return oldStock >= t && newStock < t;
}

export interface LowStockItem { name: string; unit: string; stock: number }

// Отправить предупреждение о низком остатке (одним сообщением на партию).
export async function notifyLowStock(items: LowStockItem[]): Promise<void> {
  if (!telegramEnabled() || items.length === 0) return;
  const lines = items.map(
    (i) => `• <b>${esc(i.name)}</b> — осталось ${money(i.stock)} ${unitOf(i.unit)}`,
  );
  const head =
    items.length === 1
      ? '⚠️ <b>Заканчивается товар</b>'
      : `⚠️ <b>Заканчивается товар</b> (${items.length})`;
  await sendTelegram(`${head}\n${lines.join('\n')}\n\nПора закупить.`);
}

// --- Мгновенные уведомления «шефу» ---
// Каждое — fire-and-forget: вызывается через `void notifyX(...)`, не блокирует
// кассу и не роняет её (sendTelegram сам глушит ошибки). Без токена — молчат.

// Отмены на кассе бывают частыми (кассир ошибся) — их уведомления можно
// отключить отдельно: TELEGRAM_NOTIFY_VOIDS=false.
const VOIDS_ON = (process.env.TELEGRAM_NOTIFY_VOIDS ?? 'true') !== 'false';

async function nameOf(userId: string | null | undefined): Promise<string> {
  if (!userId) return '—';
  try {
    const r = await query<{ full_name: string | null; username: string }>(
      `SELECT full_name, username FROM users WHERE id = $1`, [userId],
    );
    return r[0] ? (r[0].full_name || r[0].username) : '—';
  } catch { return '—'; }
}

const signed = (n: number) => `${n > 0 ? '+' : ''}${money(n)}`;

export async function notifyReturn(o: { userId: string; total: number; reason?: string | null; approved?: boolean }): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  const lines = [`↩️ <b>Возврат</b> на ${money(o.total)}`, `${esc(who)}${o.reason ? ` · ${esc(o.reason)}` : ''}`];
  if (o.approved) lines.push('<i>по одобрению владельца</i>');
  await sendTelegram(lines.join('\n'));
}

// Отмены позиций бывают частыми (кассир редактирует чек) и при спаме заливают
// группу. Поэтому: ПЕРВАЯ отмена сотрудника приходит сразу (сигнал «отказ» не
// теряется), а все последующие в пределах окна (TELEGRAM_VOID_WINDOW_SEC, по
// умолч. 60с) копятся и уходят ОДНОЙ сводкой в конце окна. Так максимум —
// одно мгновенное + одна сводка в минуту на сотрудника, без потока.
const VOID_WINDOW_MS = Math.max(5, Number(process.env.TELEGRAM_VOID_WINDOW_SEC || 60)) * 1000;

interface VoidWindow {
  timer: NodeJS.Timeout;
  lineCancels: number;              // сколько отмен позиций накопилось (сверх первой)
  byName: Map<string, number>;      // отмены по товарам: имя → счёт
  cartClears: number;               // сколько очисток чека накопилось
}
const voidWindows = new Map<string, VoidWindow>();

async function flushVoidWindow(userId: string): Promise<void> {
  const w = voidWindows.get(userId);
  voidWindows.delete(userId);
  if (!w) return;
  if (w.lineCancels === 0 && w.cartClears === 0) return;
  const who = await nameOf(userId);
  const secs = Math.round(VOID_WINDOW_MS / 1000);
  const total = w.lineCancels + w.cartClears;
  const lines = [`✖️ <b>Ещё отмен за ~${secs}с: ${total}</b>`, esc(who)];
  if (w.byName.size > 0) {
    const top = [...w.byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [name, n] of top) lines.push(`• ${esc(name)} — ${n}`);
  }
  if (w.cartClears > 0) lines.push(`Очисток чека: ${w.cartClears}`);
  await sendTelegram(lines.join('\n'));
}

export async function notifyVoid(o: { userId: string; kind: 'line_cancel' | 'cart_clear'; details?: any }): Promise<void> {
  if (!telegramEnabled() || !VOIDS_ON) return;
  const existing = voidWindows.get(o.userId);
  // Окно уже открыто — копим, НЕ шлём сразу (иначе спам).
  if (existing) {
    if (o.kind === 'line_cancel') {
      existing.lineCancels += 1;
      const name = o.details?.name ? String(o.details.name) : '—';
      existing.byName.set(name, (existing.byName.get(name) || 0) + 1);
    } else {
      existing.cartClears += 1;
    }
    return;
  }
  // Окна нет — первая отмена: шлём мгновенно и открываем окно на сворачивание.
  const timer = setTimeout(() => { void flushVoidWindow(o.userId); }, VOID_WINDOW_MS);
  timer.unref?.();
  voidWindows.set(o.userId, { timer, lineCancels: 0, byName: new Map(), cartClears: 0 });
  const who = await nameOf(o.userId);
  if (o.kind === 'line_cancel') {
    const d = o.details || {};
    await sendTelegram(`✖️ <b>Отмена позиции</b>\n${esc(who)}${d.name ? `: ${esc(d.name)}${d.qty != null ? ` × ${money(d.qty)}` : ''}` : ''}`);
  } else {
    await sendTelegram(`✖️ <b>Очистка чека</b>\n${esc(who)}`);
  }
}

// Для тестов/остановки: гасим все окна сворачивания отмен.
export function clearVoidWindows(): void {
  for (const w of voidWindows.values()) clearTimeout(w.timer);
  voidWindows.clear();
}

export async function notifyShiftOpen(o: {
  userId: string; cash: number; wallet: number; cashDiff: number; walletDiff: number; approved?: boolean;
}): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  const lines = [`🟢 <b>Смена открыта</b>`, esc(who), `На старте в кассе: нал ${money(o.cash)} · безнал ${money(o.wallet)}`];
  if (o.cashDiff !== 0 || o.walletDiff !== 0) {
    lines.push(`⚠️ Не сошлось с остатком прошлой смены: нал ${signed(o.cashDiff)}, безнал ${signed(o.walletDiff)}`);
  }
  if (o.approved) lines.push('<i>открытие подтвердил владелец</i>');
  await sendTelegram(lines.join('\n'));
}

export async function notifyWithdraw(o: { userId: string; amount: number; kind: 'cash' | 'wallet'; note?: string | null }): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  await sendTelegram(`🏧 <b>Изъятие из кассы</b>\n${esc(who)}: ${money(o.amount)} ${o.kind === 'wallet' ? 'безнал' : 'наличные'}${o.note ? ` · ${esc(o.note)}` : ''}`);
}

export async function notifyDeposit(o: { userId: string; amount: number; kind: 'cash' | 'wallet'; note?: string | null }): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  await sendTelegram(`🪙 <b>Внесено в кассу</b> (с рук)\n${esc(who)}: ${money(o.amount)} ${o.kind === 'wallet' ? 'безнал' : 'наличные'}${o.note ? ` · ${esc(o.note)}` : ''}`);
}

export async function notifyExpense(o: { userId: string; amount: number; category: string; paidFrom: string; approved?: boolean }): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  await sendTelegram(`💸 <b>Расход</b> ${esc(o.category)}\n${esc(who)}: ${money(o.amount)} · ${o.paidFrom === 'hand' ? 'из подотчёта' : 'из кассы'}${o.approved ? ' · <i>одобрил владелец</i>' : ''}`);
}

export async function notifySupplierPayment(o: { userId: string; amount: number; source: string }): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  const src = o.source === 'cash' ? 'из кассы · нал'
    : o.source === 'wallet' ? 'из кассы · безнал'
    : o.source === 'hand' ? 'из подотчёта' : 'со стороны';
  await sendTelegram(`📦 <b>Оплата поставщику</b>\n${esc(who)}: ${money(o.amount)} (${src})`);
}

export async function notifyRequest(o: { userId: string; what: string }): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  await sendTelegram(`🔔 <b>Нужно подтверждение</b>\n${esc(who)} просит: ${esc(o.what)}`);
}

// Крупный чек: порог суммы, выше которого слать уведомление. 0 = выключено.
const BIG_SALE = Number(process.env.TELEGRAM_BIG_SALE || 0);

export async function notifyWriteOff(o: { userId: string; name: string; qty: number; unit: string; loss: number; reason: string }): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  await sendTelegram(`📉 <b>Списание</b>\n${esc(who)}: ${esc(o.name)} × ${money(o.qty)} ${unitOf(o.unit)} · потери ${money(o.loss)}\nПричина: ${esc(o.reason)}`);
}

export async function notifyInventoryLoss(o: { userId: string; shortageCount: number; loss: number }): Promise<void> {
  if (!telegramEnabled() || o.shortageCount <= 0) return;
  const who = await nameOf(o.userId);
  await sendTelegram(`🧮 <b>Инвентаризация: недостача</b>\n${esc(who)} · не хватает позиций: ${o.shortageCount} · на ${money(o.loss)}`);
}

export async function notifyBigSale(o: { userId: string; total: number; items: number }): Promise<void> {
  if (!telegramEnabled() || !(BIG_SALE > 0) || o.total < BIG_SALE) return;
  const who = await nameOf(o.userId);
  await sendTelegram(`🧾 <b>Крупный чек</b> на ${money(o.total)}\n${esc(who)} · позиций: ${o.items}`);
}

export async function notifyPriceBulk(o: { userId: string; count: number; field: string; mode: string; value: number }): Promise<void> {
  if (!telegramEnabled() || o.count <= 0) return;
  const who = await nameOf(o.userId);
  const what = o.field === 'cost_price' ? 'закупочные цены' : 'цены продажи';
  const how = o.mode === 'percent' ? `на ${o.value > 0 ? '+' : ''}${o.value}%` : `= ${money(o.value)}`;
  await sendTelegram(`🏷 <b>Массовая смена цен</b>\n${esc(who)}: ${what} ${how} · товаров: ${o.count}`);
}

export async function notifyStaff(o: { userId: string; action: 'create' | 'block' | 'unblock' | 'pin'; targetName: string; role?: string }): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  const label = o.action === 'create' ? 'Добавлен сотрудник'
    : o.action === 'block' ? 'Заблокирован сотрудник'
    : o.action === 'unblock' ? 'Разблокирован сотрудник' : 'Сменён PIN';
  const role = o.role ? ` (${o.role === 'owner' ? 'владелец' : 'кассир'})` : '';
  await sendTelegram(`👤 <b>${label}</b>\n${esc(o.targetName)}${role}\n<i>${esc(who)}</i>`);
}

// --- Итоги дня ---

function todayLabel(): string {
  return new Date().toLocaleDateString('ru-RU', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

// Собрать и отправить итоги за сегодня (в зоне магазина) + живой баланс.
async function buildDayReport(): Promise<string> {
  const LO = `date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}'`;
  const HI = `(${LO} + interval '1 day')`;

  const s = (
    await query<any>(
      `SELECT
         COUNT(*)                                      AS receipts,
         COALESCE(SUM(total),0)                        AS revenue,
         COALESCE(SUM(cost_total),0)                   AS cost,
         COALESCE(SUM(COALESCE(cash_amount,total)),0)  AS cash,
         COALESCE(SUM(COALESCE(card_amount,0)),0)      AS card
       FROM sales WHERE created_at >= ${LO} AND created_at < ${HI}`,
    )
  )[0];
  const refunds = (
    await query<any>(`SELECT COALESCE(SUM(total),0) AS total FROM returns WHERE created_at >= ${LO} AND created_at < ${HI}`)
  )[0];
  const expenses = (
    await query<any>(
      `SELECT COALESCE(SUM(amount),0) AS total FROM expenses
        WHERE status='approved' AND created_at >= ${LO} AND created_at < ${HI}`,
    )
  )[0];

  const revenue = Number(s.revenue);
  const margin = Number((revenue - Number(s.cost)).toFixed(2));
  const marginPct = revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : 0;
  const receipts = Number(s.receipts);
  const expensesTotal = Number(expenses.total);
  const netProfit = Number((margin - expensesTotal).toFixed(2));
  const avgCheck = receipts > 0 ? Number((revenue / receipts).toFixed(2)) : 0;

  // Живой баланс: касса + подотчёт, и долг поставщикам.
  const till = await getCurrentTill();
  // «На руках» считаем ПОСТРОЧНО ПО СОТРУДНИКАМ и суммируем — ровно как Кабинет
  // (routes/dashboard.ts /balance) и выгрузка (export30.ts). Раньше здесь был
  // ГЛОБАЛЬНЫЙ SUM(amount) по cash_withdrawals без привязки к user_id, из-за чего
  // «ничьи» изъятия (user_id IS NULL или от удалённого сотрудника) попадали в
  // подотчёт только в Telegram — и цифра расходилась с кабинетом (напр. 14 331
  // против 2 149). Привязка к users убирает такие «сиротские» строки.
  // on_hand(user) = изъял − расходы из подотчёта − поставщикам из подотчёта + сверки.
  const handsAgg = (
    await query<any>(
      `SELECT COALESCE(SUM(on_hand),0) AS total FROM (
         SELECT
           COALESCE((SELECT SUM(amount) FROM cash_withdrawals WHERE user_id = u.id),0)
         - COALESCE((SELECT SUM(amount) FROM expenses WHERE user_id = u.id AND status='approved' AND paid_from='hand'),0)
         - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE user_id = u.id AND source='hand'),0)
         + COALESCE((SELECT SUM(amount) FROM accountable_adjustments WHERE user_id = u.id),0) AS on_hand
         FROM users u
       ) t`,
    )
  )[0];
  const handsTotal = Number(Number(handsAgg.total).toFixed(2));
  const tillTotal = Number((Number(till.cash) + Number(till.wallet)).toFixed(2));
  const totalCash = Number((tillTotal + handsTotal).toFixed(2));
  const debt = Number((await query<any>(`SELECT COALESCE(SUM(total - paid - returned),0) AS d FROM supplier_invoices`))[0].d);

  // Низкий остаток. ГРУППИРУЕМ ПО НАЗВАНИЮ: в каталоге бывают дубли карточек
  // одного товара (напр. «Колбаса …» ×156), и без группировки список в Telegram
  // забивался одинаковыми строками. Суммируем остаток по названию — как в
  // workflow выгрузки (lowstock.yml).
  const low = await query<{ name: string; unit: string; stock: number }>(
    `SELECT name, MIN(unit) AS unit, SUM(stock) AS stock FROM products
      WHERE is_archived = false
      GROUP BY name
      HAVING SUM(stock) < $1
      ORDER BY SUM(stock) ASC, name
      LIMIT 20`,
    [LOW_STOCK_THRESHOLD],
  );

  const lines: string[] = [];
  lines.push(`📊 <b>Итоги дня</b> · ${todayLabel()}`);
  lines.push('');
  lines.push(`Выручка: <b>${money(revenue - Number(refunds.total))}</b>`);
  lines.push(`Маржа: <b>${money(margin)}</b> (${marginPct}%)`);
  lines.push(`Расходы: ${money(expensesTotal)}`);
  lines.push(`Чистая прибыль: <b>${money(netProfit)}</b>`);
  lines.push(`Чеков: ${receipts} · средний ${money(avgCheck)}`);
  lines.push(`Наличные ${money(s.cash)} · безнал ${money(s.card)}`);
  if (Number(refunds.total) > 0) lines.push(`Возвраты: −${money(refunds.total)}`);
  lines.push('');
  lines.push(`💰 <b>Сейчас у нас денег: ${money(totalCash)}</b>`);
  lines.push(`   касса ${money(tillTotal)}${handsTotal !== 0 ? ` · на руках ${money(handsTotal)}` : ''}`);
  if (debt > 0) lines.push(`   долг поставщикам: ${money(debt)}`);

  if (low.length > 0) {
    lines.push('');
    lines.push(`🛒 <b>Пора закупить</b> (остаток &lt; ${money(LOW_STOCK_THRESHOLD)}):`);
    for (const p of low) lines.push(`• ${esc(p.name)} — ${money(p.stock)} ${unitOf(p.unit)}`);
  }

  return lines.join('\n');
}

// Отправить «итоги дня» (ручной вызов `tg:report` или опциональное расписание).
export async function sendDailyReport(): Promise<boolean> {
  if (!telegramEnabled()) return false;
  return sendTelegram(await buildDayReport());
}

// Полный отчёт при закрытии смены: сверка кассы + итоги дня + живой баланс.
// Шлётся моментально при закрытии — это основной «итог» для владельца.
export async function sendShiftCloseReport(o: {
  userId: string; expCash: number; countedCash: number; cashDiff: number;
  expWallet: number; countedWallet: number; walletDiff: number; approved?: boolean;
}): Promise<void> {
  if (!telegramEnabled()) return;
  const who = await nameOf(o.userId);
  const head = [
    `🔴 <b>Смена закрыта</b> · ${esc(who)}`,
    `Наличные: должно ${money(o.expCash)}, посчитали ${money(o.countedCash)} (${signed(o.cashDiff)})`,
    `Безнал: должно ${money(o.expWallet)}, посчитали ${money(o.countedWallet)} (${signed(o.walletDiff)})`,
  ];
  if (o.cashDiff !== 0 || o.walletDiff !== 0) head.push('⚠️ <b>Расхождение по кассе!</b>');
  if (o.approved) head.push('<i>закрытие подтвердил владелец</i>');
  await sendTelegram(head.join('\n') + '\n\n' + (await buildDayReport()));
}

// --- Планировщик итогов дня (опционально, если задан TELEGRAM_DAILY_TIME) ---
// Срабатывает каждый день в DAILY_TIME по зоне магазина. Без внешних зависимостей:
// считаем, сколько миллисекунд до ближайшего срабатывания, и ставим таймер.

let scheduled: NodeJS.Timeout | null = null;

// «Стеночное» время в зоне магазина как Date (поля = локальному времени зоны).
function wallClock(tz: string): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
}

function msUntilNext(timeStr: string): number {
  const [h, m] = timeStr.split(':').map((x) => Number(x));
  const now = wallClock(TZ);
  const target = new Date(now);
  target.setHours(Number.isFinite(h) ? h : 12, Number.isFinite(m) ? m : 0, 0, 0);
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
  return target.getTime() - now.getTime();
}

export function startTelegramScheduler(): void {
  if (!telegramEnabled()) {
    console.log('Telegram: токен/чат не заданы — уведомления выключены.');
    return;
  }
  if (!DAILY_TIME) {
    console.log('Telegram: итоги приходят при закрытии смены (фикс-время не задано).');
    return;
  }
  const arm = () => {
    const wait = msUntilNext(DAILY_TIME);
    scheduled = setTimeout(async () => {
      await sendDailyReport();
      arm(); // переставляем на следующий день
    }, wait);
    // Чтобы таймер не держал процесс (на случай завершения) — не обязателен.
    scheduled.unref?.();
    const hrs = Math.floor(wait / 3600000);
    const mins = Math.round((wait % 3600000) / 60000);
    console.log(`Telegram: итоги дня в ${DAILY_TIME} (${TZ}); ближайшая отправка через ~${hrs}ч ${mins}м.`);
  };
  arm();
}

export function stopTelegramScheduler(): void {
  if (scheduled) { clearTimeout(scheduled); scheduled = null; }
}

// --- Короткая сводка по запросу («спросил бота — он ответил») ---
// Статус смены + итоги дня + живой баланс. Это ответ бота на команду.
export async function buildSummary(): Promise<string> {
  const lines: string[] = [];
  try {
    const open = await getAnyOpenShift();
    if (open) {
      const who = open.full_name || open.username || '—';
      const since = open.opened_at
        ? new Date(open.opened_at).toLocaleTimeString('ru-RU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
        : '';
      lines.push(`🟢 <b>Смена открыта</b> · ${esc(who)}${since ? ` · с ${since}` : ''}`);
    } else {
      lines.push('⚪️ <b>Смена закрыта</b> (касса сейчас не работает)');
    }
    lines.push('');
  } catch { /* статус смены не критичен для сводки */ }
  lines.push(await buildDayReport());
  return lines.join('\n');
}

// --- Приём команд от бота (long-polling getUpdates) ---
// Владелец пишет боту в группу — бот отвечает короткой сводкой. Работает без
// вебхука и без внешних зависимостей: длинный опрос getUpdates в цикле.
// Отвечаем ТОЛЬКО в настроенном чате (группа магазина) — чтобы цифры магазина
// не утекли случайному человеку, нашедшему бота.
//
// Важно: у бота в группе по умолчанию включён «режим приватности» — ему видны
// только команды вида /... (и ответы/упоминания). Поэтому надёжнее всего
// вызывать сводку командой из меню (/report, /balance, /summary). Обычный текст
// со словами «сводка/баланс/итог» тоже сработает, если приватность выключена в
// @BotFather или если писать боту в личку (но в личке отвечаем только владельцу
// из группы — см. ALLOW ниже).

let listening = false;
let updateOffset = 0;

// Распознаём запрос сводки: любая команда /... ИЛИ ключевое слово.
function wantsSummary(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.startsWith('/')) return true;
  return /\b(сводка|сводку|итог|итоги|баланс|отчёт|отчет|сколько\s+денег|report|summary|status)\b/.test(t);
}

async function tgApi(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal,
    });
    return await res.json().catch(() => null);
  } finally {
    clearTimeout(timer);
  }
}

// Зарегистрировать команды в меню бота (кнопка «/» в Telegram).
async function registerCommands(): Promise<void> {
  await tgApi('setMyCommands', {
    commands: [
      { command: 'report', description: 'Сводка: деньги, выручка, остатки' },
      { command: 'balance', description: 'Сколько у нас денег сейчас' },
      { command: 'summary', description: 'Короткая сводка по магазину' },
    ],
  }, 8000).catch(() => {});
}

async function pollOnce(): Promise<void> {
  const data = await tgApi('getUpdates', {
    offset: updateOffset || undefined,
    timeout: 50,
    allowed_updates: ['message'],
  }, 60000);
  if (!data?.ok) {
    // ok:false — обычно вебхук активен (409) или сетевая проблема. Пауза, чтобы
    // не молотить API в тугую петлю, и видно причину в логах.
    if (data && data.ok === false) {
      console.error(`Telegram getUpdates ok=false: ${data.description || JSON.stringify(data).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
    return;
  }
  if (!Array.isArray(data.result)) return;
  if (data.result.length > 0) console.log(`Telegram: получено обновлений: ${data.result.length}`);
  for (const upd of data.result) {
    updateOffset = Math.max(updateOffset, Number(upd.update_id) + 1);
    const msg = upd.message;
    const text: string | undefined = msg?.text;
    const chatId = msg?.chat?.id != null ? String(msg.chat.id) : '';
    const chatType = msg?.chat?.type ?? '?';
    if (text) console.log(`Telegram вход: chat=${chatId}(${chatType}) текст="${text.slice(0, 48)}"`);
    if (!text || !chatId) continue;
    if (!wantsSummary(text)) continue;
    // Отвечаем ТОЛЬКО в настроенном чате магазина. Раньше тут был запасной путь
    // addressedToBot(text) — он открывал бэкдор: любой посторонний мог написать
    // боту в личку «/report@бот» и получить финсводку (в личке режим приватности
    // Telegram не действует, имя бота публично). Путь убран. Если группа
    // мигрировала в супергруппу и chat_id сменился — обновите TELEGRAM_CHAT_ID;
    // до этого бот молчит (безопасный отказ, а не утечка).
    const allowed = chatId === String(CHAT_ID);
    if (!allowed) {
      console.log(`Telegram: команда «${text.slice(0, 32)}» из чата ${chatId} пропущена (ожидался ${CHAT_ID}).`);
      continue;
    }
    console.log(`Telegram: сводка по команде «${text.slice(0, 32)}» → чат ${chatId}`);
    try {
      await sendMessageTo(chatId, await buildSummary());
    } catch (err: any) {
      console.error('Telegram: не удалось собрать сводку:', err?.message || err);
      await sendMessageTo(chatId, '⚠️ Не удалось собрать сводку. Попробуйте ещё раз.').catch(() => {});
    }
  }
}

export async function startTelegramListener(): Promise<void> {
  if (!telegramEnabled() || listening) return;
  listening = true;
  // Сбрасываем вебхук, если он вдруг был установлен: пока вебхук активен,
  // getUpdates возвращает 409 и команды не приходят.
  try { await tgApi('deleteWebhook', { drop_pending_updates: false }, 8000); } catch { /* ok */ }
  // Пропускаем накопившиеся старые сообщения: берём только последний update и
  // начинаем после него, чтобы не отвечать на всё, что писали до запуска.
  try {
    const seed = await tgApi('getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] }, 10000);
    if (seed?.ok && Array.isArray(seed.result) && seed.result.length > 0) {
      updateOffset = Number(seed.result[seed.result.length - 1].update_id) + 1;
    }
  } catch { /* не критично */ }
  await registerCommands();
  console.log(`Telegram: слушаю команды только в чате ${CHAT_ID}. Напишите в него «/report».`);
  // Фоновый цикл опроса. Ошибки не роняют кассу — пауза и продолжаем.
  (async () => {
    while (listening) {
      try {
        await pollOnce();
      } catch (err: any) {
        if (listening) {
          console.error('Telegram getUpdates:', err?.message || err);
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    }
  })();
}

export function stopTelegramListener(): void {
  listening = false;
}
