// Лента подотчёта в виде JSON (та же, что в Кабинете → «Сверка подотчёта»).
// Запуск на сервере, в контейнере app:  npm run ledger
// Печатает JSON в stdout — для выгрузки и разбора вне приложения.

import 'dotenv/config';
import { buildLedger } from './lib/ledger.js';
import { pool } from './db.js';

(async () => {
  const ledger = await buildLedger();
  process.stdout.write(JSON.stringify(ledger));
  await pool.end();
})().catch((err) => {
  console.error('Не удалось собрать ленту подотчёта:', err?.message || err);
  process.exit(1);
});
