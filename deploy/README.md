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
  "https://api.github.com/repos/relix2294/Kassa/contents/deploy/setup.sh?ref=claude/scanner-product-recognition-ujzd0v" -o /tmp/setup.sh
bash /tmp/setup.sh
```

После установки: `http://<IP-сервера>:<HOST_PORT>`, вход `owner` / `1234`
(смените PIN на экране «Сотрудники»).

## Справочник штрихкодов

При первом запуске контейнер сам, в фоне, загружает справочник штрихкодов
(открытая база: 1,8 млн строк, ~1,1 млн кодов, минута-две). После этого
«Завод товара» и «Приём» по скану подставляют название и категорию —
мгновенно и без интернета. Касса работает и во время загрузки.
Если справочник уже в базе, повторно он не качается.

Проверить, как идёт загрузка:

```bash
docker compose logs app | grep -i справочник
```

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
