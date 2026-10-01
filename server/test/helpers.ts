import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';

// Тестовый харнесс: поднимает сервер против ТЕСТОВОЙ базы, сеет владельца и
// кассира, чистит транзакционные таблицы. Боевую базу не трогает — требуем,
// чтобы имя базы содержало «test», иначе отказываемся работать.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(__dirname, '..', 'src', 'schema.sql');
const ENTRY = join(__dirname, '..', 'src', 'index.ts');

export const DB_URL = process.env.TEST_DATABASE_URL || '';
export const PORT = Number(process.env.TEST_PORT || 4555);
export const BASE = `http://127.0.0.1:${PORT}/api`;
export const JWT = 'test-secret-not-default';

export const haveDb = /test/i.test(new URL(DB_URL || 'postgres://x/none').pathname);

pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

let pool: pg.Pool;
export function db() {
  if (!pool) pool = new pg.Pool({ connectionString: DB_URL });
  return pool;
}

// Таблицы с движущимися данными — чистим перед каждым прогоном.
const DATA_TABLES = [
  'return_items', 'returns', 'return_requests', 'sale_items', 'sales',
  'cash_withdrawals', 'shift_requests', 'shifts', 'stock_receipts',
  'inventory_items', 'inventories', 'write_offs', 'activity_log',
  'supplier_payments', 'supplier_invoices', 'suppliers', 'products', 'users',
];

export async function resetDb() {
  const d = db();
  await d.query(readFileSync(SCHEMA, 'utf8'));
  for (const t of DATA_TABLES) {
    await d.query(`TRUNCATE TABLE ${t} RESTART IDENTITY CASCADE`).catch(() => {});
  }
  const ownerPin = await bcrypt.hash('1234', 10);
  const cashierPin = await bcrypt.hash('5678', 10);
  await d.query(`INSERT INTO users (username, full_name, role, pin_hash) VALUES ('owner','Владелец','owner',$1)`, [ownerPin]);
  await d.query(`INSERT INTO users (username, full_name, role, pin_hash) VALUES ('kassir','Кассир','cashier',$1)`, [cashierPin]);
}

// Товар с остатком. Возвращает { id, barcode }.
export async function addProduct(name: string, price: number, cost: number, stock: number, barcode?: string, unit = 'pcs') {
  const r = await db().query(
    `INSERT INTO products (barcode, name, unit, sale_price, cost_price, stock)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, barcode`,
    [barcode ?? null, name, unit, price, cost, stock],
  );
  return r.rows[0] as { id: string; barcode: string | null };
}

let server: ChildProcess | null = null;

export async function startServer() {
  server = spawn('npx', ['tsx', ENTRY], {
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      JWT_SECRET: JWT,
      PORT: String(PORT),
      ROLE: 'store',
      NODE_ENV: 'test',
      BARCODE_LOOKUP_URL: '',
    },
    stdio: 'ignore',
  });
  // Ждём готовности health.
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch { /* ещё поднимается */ }
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error('Сервер не поднялся за отведённое время');
}

export async function stopServer() {
  if (server) { server.kill('SIGKILL'); server = null; }
  if (pool) { await pool.end(); pool = undefined as any; }
}

// --- HTTP-хелперы ---
export async function login(username: string, pin: string): Promise<string> {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  const b = await r.json();
  return b.token;
}

export function authHeaders(token: string) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

export async function api(token: string, path: string, method = 'GET', body?: any) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await r.json(); } catch { /* пусто */ }
  return { status: r.status, body: json };
}
