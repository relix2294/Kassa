#!/usr/bin/env bash
# Бэкап базы Kassa.
#
# ТЗ п.8: «Бэкап данных — обязанность с первого дня, не фича».
# Скрипт делает сжатый дамп, проверяет его целостность и удаляет старые копии.
# Запуск вручную: npm run backup
# По расписанию: см. scripts/install-backup-cron.sh
set -euo pipefail

# --- Настройки (можно переопределить переменными окружения) ---
DB_NAME="${KASSA_DB:-kassa}"
BACKUP_DIR="${KASSA_BACKUP_DIR:-$HOME/KassaBackups}"
KEEP_DAYS="${KASSA_BACKUP_KEEP_DAYS:-30}"

# pg_dump на macOS с Homebrew часто не в PATH.
if ! command -v pg_dump >/dev/null 2>&1; then
  for p in /opt/homebrew/opt/postgresql@15/bin /usr/local/opt/postgresql@15/bin /usr/lib/postgresql/*/bin; do
    [ -x "$p/pg_dump" ] && export PATH="$p:$PATH" && break
  done
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ОШИБКА: pg_dump не найден. Установите PostgreSQL или добавьте его в PATH." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

STAMP="$(date +%Y-%m-%d_%H-%M)"
FILE="$BACKUP_DIR/kassa_$STAMP.sql.gz"

echo "Бэкап базы «$DB_NAME» → $FILE"

# Дамп во временный файл: недоделанный бэкап не должен выглядеть как готовый.
TMP="$FILE.part"
pg_dump "$DB_NAME" | gzip > "$TMP"

# Проверяем, что архив читается целиком и внутри есть данные.
if ! gzip -t "$TMP" 2>/dev/null; then
  echo "ОШИБКА: архив повреждён, бэкап не сохранён." >&2
  rm -f "$TMP"
  exit 1
fi

LINES=$(gzip -dc "$TMP" | head -50 | wc -l | tr -d ' ')
if [ "$LINES" -lt 10 ]; then
  echo "ОШИБКА: дамп подозрительно пустой, бэкап не сохранён." >&2
  rm -f "$TMP"
  exit 1
fi

mv "$TMP" "$FILE"
SIZE=$(du -h "$FILE" | cut -f1)
echo "✓ Готово: $SIZE"

# --- Чистим старые копии ---
DELETED=$(find "$BACKUP_DIR" -name 'kassa_*.sql.gz' -type f -mtime +"$KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
[ "$DELETED" -gt 0 ] && echo "Удалено старых копий (старше $KEEP_DAYS дней): $DELETED"

COUNT=$(find "$BACKUP_DIR" -name 'kassa_*.sql.gz' -type f | wc -l | tr -d ' ')
echo "Всего копий в $BACKUP_DIR: $COUNT"
