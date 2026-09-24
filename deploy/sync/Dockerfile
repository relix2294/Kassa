# Контейнер синхронизации магазина: каждые N секунд снимает дамп локальной базы
# (pg_dump) и отправляет на VPS-зеркало. Живёт только на кассе магазина
# (профиль compose "store"). На VPS не запускается.
FROM postgres:16-alpine
RUN apk add --no-cache curl
COPY sync.sh /sync.sh
RUN chmod +x /sync.sh
ENTRYPOINT ["/sync.sh"]
