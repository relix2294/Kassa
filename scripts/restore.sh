#!/usr/bin/env bash
# Восстановление базы Kassa из бэкапа.
#
# Бэкап, который никогда не восстанавливали, — это не бэкап. Этот скрипт
# нужен, чтобы восстановление было проверенной процедурой, а не импровизацией
# в тот день, когда всё сломалось.
#
#   bash scripts/restore.sh                       # список копий
#   bash scripts/restore.sh <файл>                # восстановить в базу kassa_restore_test
#   bash scripts/restore.sh <файл> kassa          # восстановить в боевую (спросит подтверждение)
set -euo pipefail

BACKUP_DIR="${KASSA_BACKUP_DIR:-$HOME/KassaBackups}"
FILE="${1:-}"
TARGET_DB="${2:-kassa_restore_test}"

if ! command -v psql >/dev/null 2>&1; then
  for p in /opt/homebrew/opt/postgresql@15/bin /usr/local/opt/postgresql@15/bin /usr/lib/postgresql/*/bin; do
    [ -x "$p/psql" ] && export PATH="$p:$PATH" && break
  done
fi

if [ -z "$FILE" ]; then
  echo "Доступные копии в $BACKUP_DIR:"
  ls -1t "$BACKUP_DIR"/kassa_*.sql.gz 2>/dev/null | head -20 || echo "  (пусто)"
  echo
  echo "Использование: bash scripts/restore.sh <файл> [имя_базы]"
  exit 0
fi

[ -f "$FILE" ] || { echo "Файл не найден: $FILE" >&2; exit 1; }

# Перезапись боевой базы — необратимая операция, спрашиваем явно.
if [ "$TARGET_DB" = "kassa" ]; then
  echo "ВНИМАНИЕ: боевая база «kassa» будет полностью заменена содержимым"
  echo "          $FILE"
  read -r -p "Введите ДА для подтверждения: " ANSWER
  [ "$ANSWER" = "ДА" ] || { echo "Отменено."; exit 1; }
fi

echo "Восстанавливаю $FILE → база «$TARGET_DB»"
dropdb --if-exists "$TARGET_DB"
createdb "$TARGET_DB"
gzip -dc "$FILE" | psql -q -d "$TARGET_DB"

echo
echo "✓ Восстановлено. Проверка содержимого:"
psql -d "$TARGET_DB" -tc "
  SELECT '  товаров: '||(SELECT count(*) FROM products)
      || ', продаж: '||(SELECT count(*) FROM sales)
      || ', смен: '||(SELECT count(*) FROM shifts)
      || ', записей в журнале: '||(SELECT count(*) FROM activity_log);"
