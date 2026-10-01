# Kassa — образ приложения: сервер (Express + WebSocket) и собранный веб
# на одном порту. Postgres живёт в отдельном контейнере (см. docker-compose.yml).
FROM node:20-slim

WORKDIR /app

# Сначала только манифесты — чтобы слой с зависимостями переиспользовался кэшем,
# пока не поменялись package.json/lock.
COPY server/package.json server/package-lock.json* ./server/
COPY web/package.json web/package-lock.json* ./web/
RUN npm --prefix server install && npm --prefix web install

# Затем исходники (node_modules и dist исключены через .dockerignore).
COPY . .

# Собираем интерфейс — сервер раздаёт web/dist с того же порта (боевой режим).
RUN npm --prefix web run build && chmod +x deploy/entrypoint.sh

ENV PORT=4000
# Боевой режим: включает серверные проверки безопасности (напр. запрет запуска
# со стандартным JWT_SECRET). Ставим ПОСЛЕ установки зависимостей и сборки,
# чтобы npm install подтянул и dev-зависимости (vite, tsx) для сборки/запуска.
ENV NODE_ENV=production
EXPOSE 4000

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
