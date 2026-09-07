import type { PoolClient } from 'pg';
import { pool } from '../db.js';
import { broadcast } from './realtime.js';

export interface LogEntry {
  type: string;
  entity?: string | null;
  entityId?: string | null;
  userId?: string | null;
  details?: unknown;
}

// Пишем запись в журнал действий и сразу шлём в realtime.
// Можно передать client, чтобы писать внутри той же транзакции.
export async function writeLog(entry: LogEntry, client?: PoolClient) {
  const runner = client ?? pool;
  const rows = await runner.query(
    `INSERT INTO activity_log (type, entity, entity_id, user_id, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [entry.type, entry.entity ?? null, entry.entityId ?? null, entry.userId ?? null, entry.details ?? null],
  );
  broadcast('log', rows.rows[0]);
  return rows.rows[0];
}
