import { Router } from 'express';
import { query } from '../db.js';
import { hashPin, requireAuth, requireOwner } from '../lib/auth.js';
import { writeLog } from '../lib/log.js';

export const usersRouter = Router();

// Все действия с пользователями — только владелец.
usersRouter.use(requireAuth, requireOwner);

// Список сотрудников (без хешей).
usersRouter.get('/', async (_req, res) => {
  const rows = await query(
    `SELECT id, username, full_name, role, is_blocked,
            (pin_hash IS NOT NULL) AS has_pin, created_at
       FROM users ORDER BY role, created_at`,
  );
  res.json(rows);
});

// Завести кассира.
usersRouter.post('/', async (req, res) => {
  const { username, full_name, pin, role } = req.body ?? {};
  if (!username || !pin) return res.status(400).json({ error: 'Нужны username и pin' });
  const r = role === 'owner' ? 'owner' : 'cashier';
  try {
    const hash = await hashPin(String(pin));
    const rows = await query(
      `INSERT INTO users (username, full_name, role, pin_hash)
       VALUES ($1,$2,$3,$4)
       RETURNING id, username, full_name, role, is_blocked, (pin_hash IS NOT NULL) AS has_pin, created_at`,
      [username, full_name ?? null, r, hash],
    );
    await writeLog({ type: 'user_create', entity: 'user', entityId: rows[0].id, userId: req.user!.id, details: { username, role: r } });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такой логин уже есть' });
    throw err;
  }
});

// Изменить сотрудника: блокировка, имя, сброс PIN.
usersRouter.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { full_name, is_blocked, pin } = req.body ?? {};

  if (pin != null) {
    const hash = await hashPin(String(pin));
    await query(`UPDATE users SET pin_hash = $2 WHERE id = $1`, [id, hash]);
    await writeLog({ type: 'user_pin_reset', entity: 'user', entityId: id, userId: req.user!.id });
  }
  const rows = await query(
    `UPDATE users SET
        full_name  = COALESCE($2, full_name),
        is_blocked = COALESCE($3, is_blocked)
      WHERE id = $1
      RETURNING id, username, full_name, role, is_blocked, (pin_hash IS NOT NULL) AS has_pin, created_at`,
    [id, full_name ?? null, is_blocked ?? null],
  );
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  if (is_blocked != null) {
    await writeLog({ type: is_blocked ? 'user_block' : 'user_unblock', entity: 'user', entityId: id, userId: req.user!.id });
  }
  res.json(rows[0]);
});
