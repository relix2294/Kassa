import express from 'express';
import 'express-async-errors';
import cors from 'cors';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { attachRealtime } from './lib/realtime.js';
import { requireAuth } from './lib/auth.js';
import { mirrorRouter } from './routes/mirror.js';
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

// Роль процесса:
//  'store'  — полноценная касса магазина (пишет данные, работает офлайн);
//  'mirror' — зеркало на VPS: только чтение (кабинет владельца) + приём снимка.
const ROLE = process.env.ROLE || 'store';

const app = express();
app.use(cors());
// Прайс поставщика на пару тысяч строк не влезает в стандартные 100 КБ.
app.use(express.json({ limit: '10mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now(), role: ROLE }));

// Приём снимка базы с кассы — до режима «только чтение» и без requireAuth
// (защищён отдельным секретом). Работает только в роли mirror (проверка внутри).
app.use('/api/mirror', mirrorRouter);

// В роли зеркала блокируем любые изменения: наружу доступны только чтение
// (кабинет/аналитика), вход и приём снимка. Единственный хозяин данных — магазин.
if (ROLE === 'mirror') {
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    if (req.path.startsWith('/auth')) return next();   // вход владельца
    if (req.path.startsWith('/mirror')) return next();  // приём снимка
    return res.status(403).json({ error: 'mirror_read_only' });
  });
}

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

// --- Боевой режим: отдаём собранный интерфейс с того же порта ---
// В разработке фронт живёт на Vite (:5173) и проксирует /api и /ws сюда.
// В бою прокси нет, поэтому сервер сам раздаёт web/dist: один процесс,
// один порт, один адрес. Так касса запускается на ноутбуке магазина.
const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(process.env.WEB_DIST || join(__dirname, '../../web/dist'));
const hasBuild = existsSync(join(webDist, 'index.html'));

if (hasBuild) {
  app.use(express.static(webDist));
  // Приложение одностраничное: любой не-API адрес отдаём как index.html,
  // иначе обновление страницы на /sale вернёт 404.
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(webDist, 'index.html'));
  });
}

// Единый обработчик ошибок, чтобы упавший роут не ронял процесс.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'internal' });
});

const port = Number(process.env.PORT) || 4000;
const server = createServer(app);
attachRealtime(server);

// host 0.0.0.0 — чтобы касса была видна с телефона владельца в той же сети.
server.listen(port, '0.0.0.0', () => {
  console.log(`✓ Kassa [${ROLE}]: http://localhost:${port}`);
  console.log(`  WebSocket: ws://localhost:${port}/ws`);
  console.log(
    hasBuild
      ? `  Интерфейс раздаётся из ${webDist}`
      : `  Интерфейса нет (${webDist}). Для боевого режима: cd web && npm run build`,
  );
});
