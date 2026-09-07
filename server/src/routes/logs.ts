import { Router } from 'express';
import { query } from '../db.js';
import { writeLog } from '../lib/log.js';
import { requireOwner } from '../lib/auth.js';

export const logsRouter = Router();

// Разрешённые типы клиентских событий (прозрачность: отмена позиции и т.п.).
const CLIENT_EVENTS = new Set(['line_cancel']);

// Записать событие с кассы в журнал (доступно любому авторизованному).
logsRouter.post('/event', async (req, res) => {
  const { type, details } = req.body ?? {};
  if (!CLIENT_EVENTS.has(type)) return res.status(400).json({ error: 'unknown event' });
  const row = await writeLog({ type, entity: 'sale', userId: req.user!.id, details: details ?? null });
  res.status(201).json(row);
});

// Журнал действий (для кабинета владельца) — только владелец. Джойним имя пользователя.
logsRouter.get('/', requireOwner, async (req, res) => {
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
