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
import { getCurrentTill } from '../routes/shifts.js';

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

// Отправка сообщения в чат. Никогда не бросает — сеть/Telegram могут лежать,
// касса из-за этого падать не должна. Возвращает true при успехе.
export async function sendTelegram(text: string): Promise<boolean> {
  if (!telegramEnabled()) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Telegram sendMessage ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('Telegram: не удалось отправить сообщение:', err?.message || err);
    return false;
  }
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

export async function notifyVoid(o: { userId: string; kind: 'line_cancel' | 'cart_clear'; details?: any }): Promise<void> {
  if (!telegramEnabled() || !VOIDS_ON) return;
  const who = await nameOf(o.userId);
  if (o.kind === 'line_cancel') {
    const d = o.details || {};
    await sendTelegram(`✖️ <b>Отмена позиции</b>\n${esc(who)}${d.name ? `: ${esc(d.name)}${d.qty != null ? ` × ${money(d.qty)}` : ''}` : ''}`);
  } else {
    await sendTelegram(`✖️ <b>Очистка чека</b>\n${esc(who)}`);
  }
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
  const handsRow = (
    await query<any>(
      `SELECT COALESCE(SUM(amount),0) AS withdrawn FROM cash_withdrawals`,
    )
  )[0];
  const handsSpent = (
    await query<any>(
      `SELECT
         (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE status='approved' AND paid_from='hand') AS ex,
         (SELECT COALESCE(SUM(amount),0) FROM supplier_payments WHERE source='hand') AS sp`,
    )
  )[0];
  const handsTotal = Number((Number(handsRow.withdrawn) - Number(handsSpent.ex) - Number(handsSpent.sp)).toFixed(2));
  const tillTotal = Number((Number(till.cash) + Number(till.wallet)).toFixed(2));
  const totalCash = Number((tillTotal + handsTotal).toFixed(2));
  const debt = Number((await query<any>(`SELECT COALESCE(SUM(total - paid),0) AS d FROM supplier_invoices`))[0].d);

  // Низкий остаток.
  const low = await query<{ name: string; unit: string; stock: number }>(
    `SELECT name, unit, stock FROM products
      WHERE is_archived = false AND stock < $1
      ORDER BY stock ASC LIMIT 20`,
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
    lines.push(`🛒 <b>Пора закупить</b> (остаток < ${money(LOW_STOCK_THRESHOLD)}):`);
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
