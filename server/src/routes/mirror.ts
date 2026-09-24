import { Router } from 'express';
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { pool } from '../db.js';
import { broadcast } from '../lib/realtime.js';

// Приём снимка базы с кассы магазина (Вариант А: магазин — хозяин данных,
// VPS — зеркало только для чтения). Каждые ~10 минут касса шлёт сюда полный
// дамп (pg_dump --inserts --clean), мы накатываем его в одной транзакции —
// атомарно: пока не COMMIT, кабинет владельца видит прежние данные.
//
// Эндпоинт работает ТОЛЬКО в роли mirror и только с правильным секретом.

export const mirrorRouter = Router();

const ROLE = process.env.ROLE || 'store';
const MIRROR_SECRET = process.env.MIRROR_SECRET || '';

function secretOk(given: string | undefined): boolean {
  if (!MIRROR_SECRET || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(MIRROR_SECRET);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Тело — сырой SQL (не JSON). Ограничение с запасом на рост базы одной точки.
mirrorRouter.post('/upload', express.text({ type: '*/*', limit: '256mb' }), async (req, res) => {
  if (ROLE !== 'mirror') {
    return res.status(400).json({ error: 'not_a_mirror' });
  }
  if (!secretOk(req.header('x-mirror-secret'))) {
    return res.status(403).json({ error: 'bad_secret' });
  }
  const raw = typeof req.body === 'string' ? req.body : '';
  if (!raw.trim()) {
    return res.status(400).json({ error: 'empty_dump' });
  }
  // Свежий pg_dump добавляет psql-команды \restrict / \unrestrict — это не SQL,
  // и драйвер на них падает. Выполняем дамп напрямую (не через psql), поэтому
  // эти строки убираем. Данных они не касаются.
  const sql = raw.replace(/^\\(un)?restrict\b.*$/gm, '');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql); // весь дамп одним заходом — DROP/CREATE/INSERT
    await client.query('COMMIT');
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Ошибка применения снимка:', err?.message || err);
    return res.status(500).json({ error: 'apply_failed', detail: String(err?.message || err) });
  } finally {
    client.release();
  }

  // Подсказываем открытым кабинетам обновить цифры.
  broadcast('data_updated', { at: Date.now() }, 'owner');
  res.json({ ok: true, bytes: sql.length, at: Date.now() });
});
