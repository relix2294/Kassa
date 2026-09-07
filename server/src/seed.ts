import { pool, query } from './db.js';
import { hashPin } from './lib/auth.js';

// Заводим владельца по умолчанию с PIN 1234 (поменять после первого входа).
const DEFAULT_OWNER_PIN = '1234';

async function main() {
  const existing = await query(`SELECT id, pin_hash FROM users WHERE username = 'owner'`);
  if (existing.length === 0) {
    const hash = await hashPin(DEFAULT_OWNER_PIN);
    await query(
      `INSERT INTO users (username, full_name, role, pin_hash) VALUES ('owner', 'Владелец', 'owner', $1)`,
      [hash],
    );
    console.log(`✓ Создан владелец: логин "owner", PIN ${DEFAULT_OWNER_PIN}`);
  } else if (!existing[0].pin_hash) {
    const hash = await hashPin(DEFAULT_OWNER_PIN);
    await query(`UPDATE users SET pin_hash = $1 WHERE username = 'owner'`, [hash]);
    console.log(`✓ Владельцу задан PIN по умолчанию: ${DEFAULT_OWNER_PIN}`);
  } else {
    console.log('· Владелец уже есть, PIN не трогаю');
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
