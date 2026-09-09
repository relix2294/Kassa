#!/usr/bin/env bash
# Ставит автоматический бэкап базы Kassa на расписание.
#
# ТЗ п.8: бэкап — обязанность с первого дня. Ручной запуск забудут,
# поэтому копия должна делаться сама.
#
# По умолчанию: каждый день в 23:30 (после закрытия магазина).
#   bash scripts/install-backup-schedule.sh            # поставить
#   bash scripts/install-backup-schedule.sh --remove   # снять
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO/scripts/backup.sh"
LOG="$HOME/KassaBackups/backup.log"
HOUR="${KASSA_BACKUP_HOUR:-23}"
MINUTE="${KASSA_BACKUP_MINUTE:-30}"
MARKER="# kassa-backup"

if [ "${1:-}" = "--remove" ]; then
  crontab -l 2>/dev/null | grep -v "$MARKER" | crontab - || true
  echo "✓ Автоматический бэкап снят с расписания."
  exit 0
fi

mkdir -p "$HOME/KassaBackups"

# Собираем строку расписания. PATH прописываем явно: cron запускается
# с урезанным окружением и не видит Homebrew.
LINE="$MINUTE $HOUR * * * PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin bash '$SCRIPT' >> '$LOG' 2>&1 $MARKER"

# Убираем старую запись, чтобы не задвоить, и ставим новую.
( crontab -l 2>/dev/null | grep -v "$MARKER" || true; echo "$LINE" ) | crontab -

echo "✓ Бэкап будет делаться каждый день в $HOUR:$MINUTE"
echo "  Скрипт: $SCRIPT"
echo "  Копии:  $HOME/KassaBackups"
echo "  Лог:    $LOG"
echo
echo "Текущее расписание:"
crontab -l | grep "$MARKER"
echo
echo "ВАЖНО: копии лежат на том же компьютере, что и база. Сгорит диск —"
echo "сгорит всё. Настройте выгрузку папки KassaBackups в облако или на"
echo "флешку, иначе это защита только от ошибки в данных, но не от потери железа."
