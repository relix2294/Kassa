import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Сокет с ролью подключившегося. До авторизации ничего не получает.
interface Client extends WebSocket {
  role?: 'owner' | 'cashier';
  userId?: string;
}

let wss: WebSocketServer | null = null;

// Кому можно слать событие:
//  'owner'  — только владельцу (деньги, маржа, журнал, смены);
//  'all'    — всем авторизованным (каталог: остатки, названия, цена продажи).
type Audience = 'owner' | 'all';

// Поля, которые кассир видеть не должен (п.4 ТЗ).
function sanitizeForCashier(type: string, payload: any) {
  if (type === 'product_upsert' && payload && typeof payload === 'object') {
    const { cost_price, ...rest } = payload;
    return rest;
  }
  return payload;
}

export function attachRealtime(server: Server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: Client) => {
    // Даём короткое окно на авторизацию, иначе рвём соединение.
    const timer = setTimeout(() => {
      if (!ws.role) ws.close(4001, 'auth timeout');
    }, 5000);

    ws.on('message', (raw) => {
      if (ws.role) return; // уже авторизован, других сообщений не ждём
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'auth' || !msg.token) return;
        const payload = jwt.verify(msg.token, JWT_SECRET) as { id: string; role: 'owner' | 'cashier' };
        ws.role = payload.role;
        ws.userId = payload.id;
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'ready', ts: Date.now() }));
      } catch {
        ws.close(4002, 'bad token');
      }
    });

    ws.on('close', () => clearTimeout(timer));
  });

  return wss;
}

// Разослать событие тем, кому оно положено по роли.
export function broadcast(type: string, payload: unknown, audience: Audience = 'owner') {
  if (!wss) return;
  for (const client of wss.clients as Set<Client>) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!client.role) continue; // не авторизован — ничего не шлём
    if (audience === 'owner' && client.role !== 'owner') continue;

    const body = client.role === 'owner' ? payload : sanitizeForCashier(type, payload);
    client.send(JSON.stringify({ type, payload: body, ts: Date.now() }));
  }
}
