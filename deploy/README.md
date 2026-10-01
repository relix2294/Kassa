# Развёртывание Kassa в Docker

Разворачивает кассу на сервере **в контейнерах**, не задевая уже работающие
на нём процессы и порты. Наружу открывается только один порт (`HOST_PORT`).

Что поднимается:
- **app** — сервер (Express + WebSocket) + собранный веб на одном порту;
- **db** — PostgreSQL 16 в своём контейнере, данные в volume `kassa-db`
  (наружу порт БД не публикуется).

## Быстрый старт (на сервере, под root)

Нужен `GITHUB_TOKEN` — токен GitHub с доступом на чтение приватного репозитория.

```bash
export GITHUB_TOKEN=ВСТАВЬ_ТОКЕН
export HOST_PORT=8080            # свой порт, если 8080 занят

curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" \
  "https://api.github.com/repos/relix2294/Kassa/contents/deploy/setup.sh?ref=claude/test-9b7fiw" -o /tmp/setup.sh
bash /tmp/setup.sh
```

После установки: `http://<IP-сервера>:<HOST_PORT>`, вход `owner` / `1234`
(смените PIN на экране «Сотрудники»).

## Управление

```bash
cd /opt/kassa/deploy
docker compose ps            # статус
docker compose logs -f app   # логи приложения
docker compose restart app   # перезапуск
docker compose down          # остановить (данные БД останутся в volume)
docker compose up -d --build # пересобрать после обновления кода
```

## Обновление кода

Повторно выполните быстрый старт (перекачает свежий код и пересоберёт образ).
Файл `deploy/.env` при этом не перезаписывается — пароль БД и `JWT_SECRET`
сохраняются, данные в volume `kassa-db` не теряются.

## Секреты

`setup.sh` создаёт `deploy/.env` со случайными `DB_PASS` и `JWT_SECRET`
(права `600`). Этот файл в git не попадает.

## Резервные копии (бэкапы)

Сервис **backup** поднимается вместе со всем остальным и раз в сутки делает
сжатый проверенный дамп базы в папку `deploy/backups` на хосте. Копии
переживают пересборку и `docker compose down` (том БД от этого не зависит).
Хранится 30 последних копий (настраивается `BACKUP_KEEP`, частота —
`BACKUP_INTERVAL` в секундах, в `deploy/.env`).

Важно: backup работает и на кассе, и на VPS-зеркале. На зеркале это уже
**оффсайт-копия** — сгорит компьютер магазина, архивы останутся на сервере.

```bash
cd /opt/kassa/deploy
ls -lt backups/                 # список копий (свежие сверху)
docker compose logs backup      # что делает сервис бэкапов
```

### Как восстановить из копии

Восстановление — проверенная процедура, а не импровизация в день аварии.
Сначала потренируйтесь на тестовой базе, и только потом — на боевой.

```bash
cd /opt/kassa/deploy
FILE=backups/kassa_2026-10-01_23-30.sql.gz     # нужная копия

# 1) ПРОВЕРКА: развернуть копию в ОТДЕЛЬНУЮ базу и убедиться, что данные целы
docker compose exec -T db psql -U kassa -d postgres -c "DROP DATABASE IF EXISTS kassa_check;"
docker compose exec -T db psql -U kassa -d postgres -c "CREATE DATABASE kassa_check;"
gzip -dc "$FILE" | docker compose exec -T db psql -q -U kassa -d kassa_check
docker compose exec -T db psql -U kassa -d kassa_check -c "SELECT count(*) AS products FROM products;"
docker compose exec -T db psql -U kassa -d postgres -c "DROP DATABASE kassa_check;"

# 2) БОЕВОЕ восстановление (данные заменятся на содержимое копии!)
docker compose stop app sync
gzip -dc "$FILE" | docker compose exec -T db psql -q -U kassa -d kassa
docker compose start app sync
```

Копии лежат на том же сервере, где и база. Для защиты от потери самого сервера
настройте выгрузку папки `deploy/backups` в облако/на другой диск — или
полагайтесь на бэкапы, которые тот же сервис делает на VPS-зеркале.
