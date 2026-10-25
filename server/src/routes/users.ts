import { Router } from 'express';
import { query } from '../db.js';
import { hashPin, requireAuth, requireOwner } from '../lib/auth.js';
import { writeLog } from '../lib/log.js';
import { notifyStaff } from '../lib/telegram.js';

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
    void notifyStaff({ userId: req.user!.id, action: 'create', targetName: full_name || username, role: r });
    res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такой логин уже есть' });
    throw err;
  }
});

// Изменить сотрудника: блокировка, имя, логин, сброс PIN.
usersRouter.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { full_name, is_blocked, pin, username } = req.body ?? {};
  // Логин можно поправить (напр. опечатка при заводе). Пустую строку не
  // принимаем — иначе человек останется без логина и не войдёт.
  const cleanUsername = typeof username === 'string' && username.trim() ? username.trim() : null;

  // Нельзя заблокировать последнего активного владельца — иначе в кабинет
  // никто не войдёт (requireAuth отклоняет заблокированных).
  if (is_blocked === true) {
    const tgt = (await query<{ role: string; is_blocked: boolean }>(
      `SELECT role, is_blocked FROM users WHERE id = $1`, [id],
    ))[0];
    if (tgt && tgt.role === 'owner' && !tgt.is_blocked) {
      const active = Number(
        (await query<{ n: number }>(`SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND is_blocked = false`))[0].n,
      );
      if (active <= 1) {
        return res.status(400).json({ error: 'Нельзя заблокировать последнего владельца — иначе никто не войдёт в кабинет.' });
      }
    }
  }

  if (pin != null) {
    const hash = await hashPin(String(pin));
    await query(`UPDATE users SET pin_hash = $2 WHERE id = $1`, [id, hash]);
    await writeLog({ type: 'user_pin_reset', entity: 'user', entityId: id, userId: req.user!.id });
  }
  const before = (await query<{ username: string; full_name: string | null }>(
    `SELECT username, full_name FROM users WHERE id = $1`, [id],
  ))[0];
  if (!before) return res.status(404).json({ error: 'not_found' });

  let rows;
  try {
    rows = await query(
      `UPDATE users SET
          full_name  = COALESCE($2, full_name),
          is_blocked = COALESCE($3, is_blocked),
          username   = COALESCE($4, username)
        WHERE id = $1
        RETURNING id, username, full_name, role, is_blocked, (pin_hash IS NOT NULL) AS has_pin, created_at`,
      [id, full_name ?? null, is_blocked ?? null, cleanUsername],
    );
  } catch (err: any) {
    if (err.code === '23505') return res.status(409).json({ error: 'Такой логин уже есть' });
    throw err;
  }
  if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
  // Правку имени/логина фиксируем в журнале (прозрачность: кто, было→стало).
  if ((cleanUsername && cleanUsername !== before.username) ||
      (full_name != null && full_name !== before.full_name)) {
    await writeLog({
      type: 'user_update', entity: 'user', entityId: id, userId: req.user!.id,
      details: {
        username: cleanUsername && cleanUsername !== before.username
          ? { old: before.username, new: cleanUsername } : undefined,
        full_name: full_name != null && full_name !== before.full_name
          ? { old: before.full_name, new: full_name } : undefined,
      },
    });
  }
  const targetName = rows[0].full_name || rows[0].username;
  if (is_blocked != null) {
    await writeLog({ type: is_blocked ? 'user_block' : 'user_unblock', entity: 'user', entityId: id, userId: req.user!.id });
    void notifyStaff({ userId: req.user!.id, action: is_blocked ? 'block' : 'unblock', targetName });
  }
  if (pin != null) void notifyStaff({ userId: req.user!.id, action: 'pin', targetName });
  res.json(rows[0]);
});
