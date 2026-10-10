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
const DAILY_TIME = process.env.TELEGRAM_DAILY_TIME || '12:00';
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

// --- Итоги дня ---

function todayLabel(): string {
  return new Date().toLocaleDateString('ru-RU', {
    timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

// Собрать и отправить итоги за сегодня (в зоне магазина) + живой баланс.
export async function sendDailyReport(): Promise<boolean> {
  if (!telegramEnabled()) return false;

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

  return sendTelegram(lines.join('\n'));
}

// --- Планировщик итогов дня ---
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
