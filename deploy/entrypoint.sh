#!/bin/sh
# Запуск приложения в контейнере: дождаться БД, применить схему, создать
# владельца (если нужно), поднять сервер. Всё безопасно при повторных стартах.
set -e

echo "→ Жду PostgreSQL и применяю схему..."
i=1
migrated=""
while [ "$i" -le 30 ]; do
  if npm --prefix /app/server run migrate; then
    echo "→ Схема применена"
    migrated=1
    break
  fi
  echo "  БД ещё не готова, попытка $i/30..."
  i=$((i + 1))
  sleep 2
done

# Если за 30 попыток (~60 c) схема так и не применилась — НЕ стартуем сломанными
# против неинициализированной БД, а падаем. restart: unless-stopped поднимет
# контейнер заново и попробует снова, вместо «полуживого» процесса.
if [ -z "$migrated" ]; then
  echo "✗ ОТКАЗ: БД недоступна или миграция не прошла за 30 попыток. Выходим." >&2
  exit 1
fi

npm --prefix /app/server run seed || echo "→ seed пропущен (владелец уже есть)"

echo "→ Запуск Kassa на порту ${PORT}"
exec npm --prefix /app/server start
