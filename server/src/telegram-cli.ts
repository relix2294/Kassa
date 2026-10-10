// Небольшой помощник для настройки Telegram-бота. Запуск:
//   npm run tg:chatid   — показать id чатов/групп, куда добавлен бот
//   npm run tg:test     — отправить проверочное сообщение в TELEGRAM_CHAT_ID
//   npm run tg:report   — отправить настоящие «итоги дня» прямо сейчас
//
// Перед tg:chatid: создайте бота у @BotFather, положите токен в TELEGRAM_BOT_TOKEN
// (server/.env), добавьте бота в вашу группу и напишите там любое сообщение.

import 'dotenv/config';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const cmd = process.argv[2] || 'chatid';

function need(cond: boolean, msg: string) {
  if (!cond) { console.error(msg); process.exit(1); }
}

async function chatid() {
  need(!!TOKEN, 'Нет TELEGRAM_BOT_TOKEN. Создайте бота у @BotFather и задайте токен в server/.env');
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
  const data: any = await res.json();
  if (!data.ok) { console.error('Telegram ответил ошибкой:', JSON.stringify(data)); process.exit(1); }
  const chats = new Map<number, { type: string; title: string }>();
  for (const u of data.result || []) {
    const c = u.message?.chat || u.channel_post?.chat || u.my_chat_member?.chat;
    if (c) chats.set(c.id, { type: c.type, title: c.title || c.username || c.first_name || '' });
  }
  if (chats.size === 0) {
    console.log('Чатов не найдено. Добавьте бота в группу и напишите там любое сообщение,');
    console.log('затем снова запустите: npm run tg:chatid');
    return;
  }
  console.log('Найденные чаты (возьмите id вашей группы в TELEGRAM_CHAT_ID):\n');
  for (const [id, info] of chats) {
    console.log(`  ${id}\t${info.type}\t${info.title}`);
  }
}

async function test() {
  const { sendTelegram, telegramEnabled } = await import('./lib/telegram.js');
  need(telegramEnabled(), 'Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в server/.env');
  const ok = await sendTelegram('✅ <b>Kassa</b> подключена к этой группе. Уведомления будут приходить сюда.');
  console.log(ok ? 'Отправлено ✓ — проверьте группу.' : 'Не удалось отправить. Проверьте токен и chat id.');
  process.exit(ok ? 0 : 1);
}

async function report() {
  const { sendDailyReport, telegramEnabled } = await import('./lib/telegram.js');
  need(telegramEnabled(), 'Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в server/.env');
  const ok = await sendDailyReport();
  console.log(ok ? 'Итоги дня отправлены ✓' : 'Не удалось отправить итоги дня.');
  process.exit(ok ? 0 : 1);
}

const run = cmd === 'test' ? test : cmd === 'report' ? report : chatid;
run().catch((e) => { console.error(e?.message || e); process.exit(1); });
