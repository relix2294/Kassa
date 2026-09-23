#!/bin/sh
# Запуск приложения в контейнере: дождаться БД, применить схему, создать
# владельца (если нужно), поднять сервер. Всё безопасно при повторных стартах.
set -e

echo "→ Жду PostgreSQL и применяю схему..."
i=1
while [ "$i" -le 30 ]; do
  if npm --prefix /app/server run migrate; then
    echo "→ Схема применена"
    break
  fi
  echo "  БД ещё не готова, попытка $i/30..."
  i=$((i + 1))
  sleep 2
done

npm --prefix /app/server run seed || echo "→ seed пропущен (владелец уже есть)"

echo "→ Запуск Kassa на порту ${PORT}"
exec npm --prefix /app/server start
