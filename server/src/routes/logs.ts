import { Router } from 'express';
import { query } from '../db.js';

export const logsRouter = Router();

// Журнал действий (для кабинета владельца). Джойним имя пользователя.
logsRouter.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const rows = await query(
    `SELECT l.*, u.username, u.full_name
       FROM activity_log l
       LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.created_at DESC
      LIMIT $1`,
    [limit],
  );
  res.json(rows);
});
