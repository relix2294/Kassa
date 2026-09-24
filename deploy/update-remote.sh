#!/usr/bin/env bash
# =====================================================================
#  Kassa — обновление уже установленной кассы на сервере.
#  Запускает GitHub Actions (.github/workflows/deploy-vps.yml) по SSH;
#  новый код уже лежит в /tmp/kassa-deploy.tgz.
#
#  Что НЕ трогается: база (volume kassa-db), deploy/.env (пароли, порт,
#  роль store/mirror). Перед обновлением снимается копия базы. Если новая
#  версия не поднялась — возвращается предыдущая, сама.
# =====================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/kassa}"
PREV_DIR="${APP_DIR}.prev"
BACKUP_DIR="${BACKUP_DIR:-/opt/kassa-backups}"
TARBALL="${TARBALL:-/tmp/kassa-deploy.tgz}"
KEEP_BACKUPS=10

SUDO=""
[ "$(id -u)" = "0" ] || SUDO="sudo -n"

fail() { echo "!! $*" >&2; exit 1; }

[ -f "$APP_DIR/deploy/.env" ] || fail "Касса не установлена: нет $APP_DIR/deploy/.env. Сначала один раз запусти deploy/setup.sh."
[ -f "$TARBALL" ] || fail "Нет архива с кодом: $TARBALL"

HOST_PORT="$(grep -E '^HOST_PORT=' "$APP_DIR/deploy/.env" | cut -d= -f2 | tr -d '[:space:]')"
HOST_PORT="${HOST_PORT:-8080}"

compose() { (cd "$1/deploy" && $SUDO docker compose "${@:2}"); }

healthy() {
  for _ in $(seq 1 45); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

echo "==> 1/4 Копия базы перед обновлением"
$SUDO mkdir -p "$BACKUP_DIR"
if compose "$APP_DIR" ps --status running --services 2>/dev/null | grep -qx db; then
  FILE="$BACKUP_DIR/kassa_before_update_$(date +%Y%m%d_%H%M%S).sql.gz"
  compose "$APP_DIR" exec -T db pg_dump -U kassa kassa | gzip | $SUDO tee "$FILE" >/dev/null
  # Пустой дамп — значит копия не снялась; обновлять без неё не будем.
  [ "$(gzip -dc "$FILE" | head -c 100 | wc -c)" -gt 0 ] || fail "Не удалось снять копию базы — обновление отменено."
  echo "    $FILE"
  # Оставляем последние $KEEP_BACKUPS копий.
  ls -1t "$BACKUP_DIR"/kassa_before_update_*.sql.gz 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r $SUDO rm -f
else
  echo "    база сейчас не запущена — копию пропускаю"
fi

echo "==> 2/4 Раскладываю новый код"
NEW_DIR="$($SUDO mktemp -d "${APP_DIR}.new.XXXXXX")"
$SUDO tar -xzf "$TARBALL" -C "$NEW_DIR"
$SUDO cp -p "$APP_DIR/deploy/.env" "$NEW_DIR/deploy/.env"
$SUDO rm -rf "$PREV_DIR"
$SUDO mv "$APP_DIR" "$PREV_DIR"
$SUDO mv "$NEW_DIR" "$APP_DIR"
$SUDO rm -f "$TARBALL"

rollback() {
  echo "!! Новая версия не поднялась — возвращаю предыдущую."
  compose "$APP_DIR" logs --tail 60 app || true
  $SUDO rm -rf "$APP_DIR"
  $SUDO mv "$PREV_DIR" "$APP_DIR"
  compose "$APP_DIR" up -d --build || true
  fail "Обновление откатено, касса работает на прежней версии. Причина — в логе выше."
}

echo "==> 3/4 Сборка и перезапуск (база и настройки остаются)"
compose "$APP_DIR" up -d --build || rollback

echo "==> 4/4 Проверяю, что касса отвечает на порту ${HOST_PORT}"
healthy || rollback

# Старые слои образов занимают место на диске — чистим только неиспользуемые.
$SUDO docker image prune -f >/dev/null 2>&1 || true

echo "======================================================"
echo "  Касса обновлена и отвечает: http://<IP>:${HOST_PORT}"
echo "  Прежняя версия кода: ${PREV_DIR}"
echo "  Копии базы: ${BACKUP_DIR}"
echo "======================================================"
