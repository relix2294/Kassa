import { Router } from 'express';
import { query } from '../db.js';
import { signToken, verifyPin, requireAuth } from '../lib/auth.js';

export const authRouter = Router();

// Защита от перебора PIN. PIN короткий (4 цифры = 10 000 вариантов), поэтому
// без ограничения его можно подобрать ботом. Считаем неудачные попытки на
// логин в скользящем окне; после лимита — временно отказываем. Успешный вход
// сбрасывает счётчик. Память процесса — для одной точки этого достаточно.
const MAX_FAILS = 7;
const WINDOW_MS = 10 * 60 * 1000; // 10 минут
const fails = new Map<string, number[]>();

function recentFails(key: string): number {
  const now = Date.now();
  const arr = (fails.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (arr.length) fails.set(key, arr);
  else fails.delete(key);
  return arr.length;
}

// Вход по имени пользователя и PIN.
authRouter.post('/login', async (req, res) => {
  const { username, pin } = req.body ?? {};
  if (!username || !pin) return res.status(400).json({ error: 'Нужны username и pin' });

  const key = String(username).toLowerCase().trim();
  if (recentFails(key) >= MAX_FAILS) {
    return res.status(429).json({ error: 'Слишком много попыток входа. Подождите несколько минут и попробуйте снова.' });
  }

  const rows = await query(`SELECT * FROM users WHERE username = $1`, [username]);
  const u = rows[0];
  const ok = u && !u.is_blocked && u.pin_hash && (await verifyPin(String(pin), u.pin_hash));
  if (!ok) {
    const arr = fails.get(key) ?? [];
    arr.push(Date.now());
    fails.set(key, arr);
    return res.status(401).json({ error: 'Неверный логин или PIN' });
  }

  fails.delete(key); // успешный вход — сбрасываем счётчик
  const user = { id: u.id, username: u.username, role: u.role, full_name: u.full_name };
  const token = signToken(user);
  res.json({ token, user });
});

// Текущий пользователь по токену.
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
