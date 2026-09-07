import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// Возвращаем numeric как number, а не string, чтобы фронту было удобно.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    'postgres://localhost:5432/kassa',
});

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

// Хелпер для транзакций.
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
