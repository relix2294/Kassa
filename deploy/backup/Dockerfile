# Контейнер резервного копирования: Postgres-клиент + gzip + cron-подобный цикл.
FROM postgres:16-alpine
COPY backup.sh /backup.sh
RUN chmod +x /backup.sh
ENTRYPOINT ["/backup.sh"]
