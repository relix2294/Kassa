import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import { createServer } from 'node:http';
import 'dotenv/config';

import { attachRealtime } from './lib/realtime.js';
import { requireAuth } from './lib/auth.js';
import { authRouter } from './routes/auth.js';
import { productsRouter } from './routes/products.js';
import { receivingRouter } from './routes/receiving.js';
import { salesRouter } from './routes/sales.js';
import { returnsRouter } from './routes/returns.js';
import { shiftsRouter } from './routes/shifts.js';
import { dashboardRouter } from './routes/dashboard.js';
import { analyticsRouter } from './routes/analytics.js';
import { logsRouter } from './routes/logs.js';
import { usersRouter } from './routes/users.js';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.use('/api/auth', authRouter);
app.use('/api/products', requireAuth, productsRouter);
app.use('/api/receiving', requireAuth, receivingRouter);
app.use('/api/sales', requireAuth, salesRouter);
app.use('/api/returns', requireAuth, returnsRouter);
app.use('/api/shifts', requireAuth, shiftsRouter);
app.use('/api/dashboard', requireAuth, dashboardRouter);
app.use('/api/analytics', requireAuth, analyticsRouter);
app.use('/api/logs', requireAuth, logsRouter);
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
