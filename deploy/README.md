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
