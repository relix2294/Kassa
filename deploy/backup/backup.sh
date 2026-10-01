#!/bin/sh
# Регулярный бэкап базы Kassa внутри Docker-развёртывания.
#
# ТЗ п.8: «Бэкап данных — обязанность с первого дня, не фича». Делаем сжатый
# дамп, проверяем целостность, пишем атомарно и чистим старые копии. Папка
# /backups смонтирована на хост (deploy/backups) — копии переживают пересборку
# и `docker compose down` (том БД от этого не зависит).
#
# Логика самолечащаяся, как у sync: не вышло один раз — выйдет в следующий цикл.
set -eu

: "${DB_HOST:=db}"
: "${DB_USER:=kassa}"
: "${DB_NAME:=kassa}"
: "${PGPASSWORD:?нужен PGPASSWORD (пароль БД)}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_INTERVAL:=86400}"        # как часто делать (сек). По умолчанию раз в сутки.
: "${BACKUP_KEEP:=30}"               # сколько копий хранить (дней/файлов по mtime).
: "${BACKUP_FIRST_DELAY:=120}"       # пауза перед первым дампом (дать БД подняться).

export PGPASSWORD
mkdir -p "$BACKUP_DIR"

echo "backup: старт. Интервал ${BACKUP_INTERVAL}s, хранить ${BACKUP_KEEP}, папка ${BACKUP_DIR}"
sleep "$BACKUP_FIRST_DELAY"

make_backup() {
  ts="$(date -u '+%Y-%m-%d_%H-%M')"
  file="$BACKUP_DIR/kassa_$ts.sql.gz"
  tmp="$file.part"

  # --clean --if-exists: дамп самодостаточен (восстановление пересоздаёт объекты).
  # Чистый SQL (без COPY-бинарщины) — простое и переносимое восстановление.
  if ! pg_dump --clean --if-exists --no-owner --no-privileges \
        -h "$DB_HOST" -U "$DB_USER" "$DB_NAME" 2>/tmp/err | gzip > "$tmp"; then
    echo "[$ts] ОШИБКА pg_dump: $(cat /tmp/err 2>/dev/null)"
    rm -f "$tmp"
    return 1
  fi

  # Проверяем архив: читается целиком и не подозрительно пустой.
  if ! gzip -t "$tmp" 2>/dev/null; then
    echo "[$ts] ОШИБКА: архив повреждён, не сохраняю."; rm -f "$tmp"; return 1
  fi
  lines="$(gzip -dc "$tmp" | head -50 | wc -l | tr -d ' ')"
  if [ "$lines" -lt 10 ]; then
    echo "[$ts] ОШИБКА: дамп пустой, не сохраняю."; rm -f "$tmp"; return 1
  fi

  mv "$tmp" "$file"
  size="$(wc -c < "$file" | tr -d ' ')"
  echo "[$ts] ✓ бэкап готов (${size} байт): $file"

  # Чистим старые копии (по времени модификации).
  find "$BACKUP_DIR" -name 'kassa_*.sql.gz' -type f -mtime +"$BACKUP_KEEP" -print -delete 2>/dev/null \
    | while read -r old; do echo "  удалена старая копия: $old"; done || true
}

while true; do
  make_backup || echo "backup: повтор в следующем цикле"
  sleep "$BACKUP_INTERVAL"
done
