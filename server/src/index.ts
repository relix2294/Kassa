import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import { createServer } from 'node:http';
import 'dotenv/config';

import { attachRealtime } from './lib/realtime.js';
import { productsRouter } from './routes/products.js';
import { receivingRouter } from './routes/receiving.js';
import { logsRouter } from './routes/logs.js';
import { usersRouter } from './routes/users.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/api/products', productsRouter);
app.use('/api/receiving', receivingRouter);
app.use('/api/logs', logsRouter);
app.use('/api/users', usersRouter);

// Единый обработчик ошибок, чтобы упавший роут не ронял процесс.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'internal' });
});

const port = Number(process.env.PORT) || 4000;
const server = createServer(app);
attachRealtime(server);

server.listen(port, () => {
  console.log(`✓ Kassa server слушает http://localhost:${port}`);
  console.log(`  WebSocket: ws://localhost:${port}/ws`);
});
