import { Router } from 'express';
import { query } from '../db.js';

export const usersRouter = Router();

// Список пользователей (полноценные роли/логин — этап 3).
usersRouter.get('/', async (_req, res) => {
  const rows = await query(
    `SELECT id, username, full_name, role, is_blocked, created_at FROM users ORDER BY created_at`,
  );
  res.json(rows);
});
