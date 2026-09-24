#!/usr/bin/env bash
# =====================================================================
#  Kassa — установка в Docker на сервере.
#  НЕ трогает существующие процессы и порты: всё живёт в контейнерах,
#  наружу торчит только один порт (HOST_PORT).
#
#  Запуск (под root):
#     GITHUB_TOKEN=xxxxx bash setup.sh
#  Свой внешний порт (если 8080 занят):
#     HOST_PORT=8090 GITHUB_TOKEN=xxxxx bash setup.sh
# =====================================================================
set -euo pipefail

REPO="relix2294/Kassa"
REF="${REF:-claude/scanner-product-recognition-ujzd0v}"
APP_DIR="${APP_DIR:-/opt/kassa}"
HOST_PORT="${HOST_PORT:-8080}"

if [ "$(id -u)" != "0" ]; then
  echo "Запусти под root:  sudo -i , затем команду снова"; exit 1
fi
# GITHUB_TOKEN нужен, только если репозиторий приватный. Если он публичный
# (даже временно) — код качается без токена. Ниже сработает нужный вариант.

# --- базовые утилиты ---
command -v curl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl; }
command -v tar  >/dev/null 2>&1 || { apt-get update -y && apt-get install -y tar; }
command -v openssl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y openssl; }

echo "==> 1/5 Docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "    Docker не найден — ставлю официальным скриптом..."
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "    Нет плагина 'docker compose'. Установи docker-compose-plugin и повтори."; exit 1
fi

echo "==> 2/5 Проверяю, что порт ${HOST_PORT} свободен"
if ss -ltn 2>/dev/null | grep -q ":${HOST_PORT} "; then
  echo "!!  Порт ${HOST_PORT} уже занят. Выбери другой:  HOST_PORT=NNNN GITHUB_TOKEN=... bash setup.sh"
  exit 1
fi

echo "==> 3/5 Забираю код в ${APP_DIR}"
mkdir -p "$APP_DIR"
TARBALL_URL="https://api.github.com/repos/${REPO}/tarball/${REF}"
if [ -n "${GITHUB_TOKEN:-}" ]; then
  # Приватный репозиторий — с токеном.
  curl -fsSL -H "Authorization: Bearer ${GITHUB_TOKEN}" "$TARBALL_URL" -o /tmp/kassa.tgz
else
  # Публичный репозиторий — без токена.
  if ! curl -fsSL "$TARBALL_URL" -o /tmp/kassa.tgz; then
    echo "!!  Не удалось скачать код без токена."
    echo "    Значит репозиторий приватный. Два пути:"
    echo "    1) Сделай репозиторий публичным на пару минут и запусти снова, ЛИБО"
    echo "    2) запусти с токеном:  GITHUB_TOKEN=xxxx bash setup.sh"
    exit 1
  fi
fi
tar -xzf /tmp/kassa.tgz -C "$APP_DIR" --strip-components=1
rm -f /tmp/kassa.tgz

echo "==> 4/5 Секреты (deploy/.env)"
ENV_FILE="$APP_DIR/deploy/.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
DB_PASS=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
HOST_PORT=${HOST_PORT}
EOF
  chmod 600 "$ENV_FILE"
  echo "    Создан $ENV_FILE (пароль БД и JWT_SECRET сгенерированы)"
else
  echo "    $ENV_FILE уже есть — оставляю (секреты и порт не меняю)"
fi

echo "==> 5/5 Сборка и запуск контейнеров"
cd "$APP_DIR/deploy"
docker compose up -d --build

echo
IP="$(curl -s --max-time 5 ifconfig.me || echo SERVER_IP)"
PORT_NOW="$(grep -E '^HOST_PORT=' "$ENV_FILE" | cut -d= -f2)"
echo "======================================================"
echo "  Kassa поднята в Docker."
echo "  Адрес:   http://${IP}:${PORT_NOW}"
echo "  Вход:    owner / 1234   (смени PIN после первого входа!)"
echo
echo "  Статус:  docker compose -f ${APP_DIR}/deploy/docker-compose.yml ps"
echo "  Логи:    docker compose -f ${APP_DIR}/deploy/docker-compose.yml logs -f app"
echo "  Стоп:    docker compose -f ${APP_DIR}/deploy/docker-compose.yml down"
echo "======================================================"
