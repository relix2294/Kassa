import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'node:http';

let wss: WebSocketServer | null = null;

// Поднимаем WebSocket-сервер поверх того же http-сервера.
export function attachRealtime(server: Server) {
  wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
  });
  return wss;
}

// Разослать событие всем подключённым клиентам (кабинет владельца и т.п.).
export function broadcast(type: string, payload: unknown) {
  if (!wss) return;
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}
