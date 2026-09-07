import { pool, query } from './db.js';

// Заводим владельца по умолчанию, чтобы действия было к кому привязывать.
// Полноценный логин/роли — этап 3.
async function main() {
  const existing = await query(`SELECT id FROM users WHERE username = 'owner'`);
  if (existing.length === 0) {
    await query(
      `INSERT INTO users (username, full_name, role) VALUES ('owner', 'Владелец', 'owner')`,
    );
    console.log('✓ Создан пользователь owner');
  } else {
    console.log('· Пользователь owner уже есть');
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
