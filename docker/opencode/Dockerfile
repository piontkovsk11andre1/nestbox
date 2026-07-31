FROM composer:latest AS vendor

WORKDIR /build
COPY ./home/configs/php/composer.json ./composer.json
COPY ./home/configs/php/composer.lock ./composer.lock
RUN composer install --no-interaction --prefer-dist --optimize-autoloader --no-dev

FROM ghcr.io/anomalyco/opencode:latest

ARG APP_UID=1000
ARG APP_GID=1000

RUN apk add --no-cache git php85 php85-dom php85-mbstring php85-openssl php85-phar php85-tokenizer php85-xml php85-xmlwriter su-exec && \
    ln -s /usr/bin/php85 /usr/local/bin/php && \
    addgroup -g "${APP_GID}" -S nestbox && \
    adduser -u "${APP_UID}" -G nestbox -S -h /home/nestbox nestbox

ENV OPENCODE_CONFIG=/etc/opencode/opencode.json
ENV HOME=/home/nestbox

COPY --from=vendor /build/vendor /vendor
COPY ./home/configs/php /sources/php
COPY ./home/configs/opencode /etc/opencode
COPY ./home/code /home/code
COPY ./docker/opencode/entrypoint.sh /usr/local/bin/nestbox-opencode-entrypoint

RUN chmod 0755 /usr/local/bin/nestbox-opencode-entrypoint && \
    mkdir -p /home/nestbox/.local/share/opencode && \
    chown -R nestbox:nestbox /home/nestbox /home/code

WORKDIR /workspace

EXPOSE 4096

ENTRYPOINT ["/usr/local/bin/nestbox-opencode-entrypoint"]
CMD ["serve", "--hostname", "0.0.0.0", "--port", "4096"]
