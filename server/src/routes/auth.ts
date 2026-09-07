import { Router } from 'express';
import { query } from '../db.js';
import { signToken, verifyPin, requireAuth } from '../lib/auth.js';

export const authRouter = Router();

// Вход по имени пользователя и PIN.
authRouter.post('/login', async (req, res) => {
  const { username, pin } = req.body ?? {};
  if (!username || !pin) return res.status(400).json({ error: 'Нужны username и pin' });

  const rows = await query(`SELECT * FROM users WHERE username = $1`, [username]);
  const u = rows[0];
  if (!u || u.is_blocked || !u.pin_hash) {
    return res.status(401).json({ error: 'Неверный логин или PIN' });
  }
  const ok = await verifyPin(String(pin), u.pin_hash);
  if (!ok) return res.status(401).json({ error: 'Неверный логин или PIN' });

  const user = { id: u.id, username: u.username, role: u.role, full_name: u.full_name };
  const token = signToken(user);
  res.json({ token, user });
});

// Текущий пользователь по токену.
authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
