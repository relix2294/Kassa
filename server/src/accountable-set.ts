// Разовая сверка подотчёта из командной строки: привести остаток «на руках»
// сотрудника к фактическому. Удобно для стартовой точки.
//
// Запуск (на сервере, в контейнере app):
//   npm run accountable:set -- <логин> <сумма>
//   пример: npm run accountable:set -- owner 1989
// Либо через переменные окружения: ACC_USER=owner ACC_AMOUNT=1989 npm run accountable:set

import 'dotenv/config';
import { query } from './db.js';

const username = (process.argv[2] ?? process.env.ACC_USER ?? '').trim();
const target = Number(process.argv[3] ?? process.env.ACC_AMOUNT);

if (!username || !Number.isFinite(target) || target < 0) {
  console.error('Использование: npm run accountable:set -- <логин> <сумма>');
  console.error('Пример:        npm run accountable:set -- owner 1989');
  process.exit(1);
}

(async () => {
  const u = (
    await query<{ id: string; full_name: string | null; username: string }>(
      `SELECT id, full_name, username FROM users WHERE username = $1`,
      [username],
    )
  )[0];
  if (!u) {
    console.error(`Пользователь «${username}» не найден.`);
    process.exit(1);
  }

  // Текущий остаток «на руках» = изъятия − траты из подотчёта + прошлые сверки.
  const cur = Number(
    (
      await query<{ cur: number }>(
        `SELECT (
             COALESCE((SELECT SUM(amount) FROM cash_withdrawals WHERE user_id = $1), 0)
           - COALESCE((SELECT SUM(amount) FROM expenses WHERE user_id = $1 AND status='approved' AND paid_from='hand'), 0)
           - COALESCE((SELECT SUM(amount) FROM supplier_payments WHERE user_id = $1 AND source='hand'), 0)
           + COALESCE((SELECT SUM(amount) FROM accountable_adjustments WHERE user_id = $1), 0)
         ) AS cur`,
        [u.id],
      )
    )[0].cur,
  );

  const delta = Number((target - cur).toFixed(2));
  if (delta === 0) {
    console.log(`На руках у «${u.full_name || u.username}» уже ${target} — корректировка не нужна.`);
    process.exit(0);
  }

  await query(
    `INSERT INTO accountable_adjustments (user_id, amount, note, created_by) VALUES ($1, $2, $3, $1)`,
    [u.id, delta, `сверка (CLI): старт ${target}`],
  );
  console.log(
    `✓ «${u.full_name || u.username}»: на руках было ${cur}, стало ${target} (корректировка ${delta > 0 ? '+' : ''}${delta}).`,
  );
  process.exit(0);
})().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
