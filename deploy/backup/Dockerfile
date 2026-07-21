FROM alpine:3.20
RUN apk add --no-cache bash postgresql16-client restic tzdata
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh \
  && echo '30 3 * * * /usr/local/bin/backup.sh >> /backups/backup.log 2>&1' > /etc/crontabs/root
CMD ["crond", "-f", "-l", "2"]
