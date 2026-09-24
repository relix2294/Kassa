#!/bin/sh
# Отправка снимка локальной базы на VPS-зеркало.
#
# Логика проста и самолечащаяся: раз в SYNC_INTERVAL секунд делаем ПОЛНЫЙ дамп
# и шлём его целиком. Если отправка не удалась (интернет моргнул) — ничего
# страшного: следующая успешная отправка привезёт на зеркало сразу всё
# актуальное. Никакой очереди и потерянных кусков.
set -eu

: "${DB_HOST:=db}"
: "${DB_USER:=kassa}"
: "${DB_NAME:=kassa}"
: "${PGPASSWORD:?нужен PGPASSWORD (пароль БД)}"
: "${MIRROR_URL:?нужен MIRROR_URL (https://VPS:порт/api/mirror/upload)}"
: "${MIRROR_SECRET:?нужен MIRROR_SECRET (общий секрет с зеркалом)}"
: "${SYNC_INTERVAL:=600}"

export PGPASSWORD

echo "sync: старт. Интервал ${SYNC_INTERVAL}s, цель ${MIRROR_URL}"

while true; do
  ts="$(date -u '+%Y-%m-%d %H:%M:%SZ')"

  # --inserts: чистый SQL (без COPY), чтобы зеркало могло накатить его напрямую.
  # --clean/--if-exists: снимок самодостаточен, пересоздаёт объекты.
  if pg_dump --inserts --clean --if-exists --no-owner --no-privileges \
       -h "$DB_HOST" -U "$DB_USER" "$DB_NAME" > /tmp/dump.sql 2>/tmp/dump.err; then
    size="$(wc -c < /tmp/dump.sql | tr -d ' ')"
    if curl -fsS --max-time 120 -X POST "$MIRROR_URL" \
         -H "X-Mirror-Secret: ${MIRROR_SECRET}" \
         -H "Content-Type: application/sql" \
         --data-binary @/tmp/dump.sql -o /tmp/resp.json; then
      echo "[$ts] отправлено (${size} байт)"
    else
      echo "[$ts] отправка не удалась — повтор через ${SYNC_INTERVAL}s"
    fi
  else
    echo "[$ts] pg_dump ошибка: $(cat /tmp/dump.err)"
  fi

  sleep "$SYNC_INTERVAL"
done
