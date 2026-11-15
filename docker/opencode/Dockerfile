FROM composer:latest AS vendor

WORKDIR /build
COPY ./home/configs/php/composer.json ./composer.json
COPY ./home/configs/php/composer.lock ./composer.lock
RUN composer install --no-interaction --prefer-dist --optimize-autoloader --no-dev

FROM ghcr.io/anomalyco/opencode:latest

ARG APP_UID=1000
ARG APP_GID=1000

# Alpine names PHP packages by branch. Select its newest available branch
# instead of retaining an older branch as the rolling base image advances.
RUN php_package="$(apk search --no-cache --quiet --exact 'php[0-9]*' | grep -E '^php[0-9]+$' | sort -V | tail -n 1)" && \
    test -n "$php_package" && \
    apk add --no-cache git nodejs npm "$php_package" "$php_package-dom" "$php_package-mbstring" "$php_package-openssl" "$php_package-phar" "$php_package-tokenizer" "$php_package-xml" "$php_package-xmlwriter" su-exec && \
    ln -s "/usr/bin/$php_package" /usr/local/bin/php && \
    addgroup -g "${APP_GID}" -S nestbox && \
    adduser -u "${APP_UID}" -G nestbox -S -h /home/nestbox nestbox

RUN npm install --prefix /opt/do-md --engine-strict --omit=dev --no-audit --no-fund @p10i/do-md@latest && \
    ln -s /opt/do-md/node_modules/.bin/do-md /usr/local/bin/do-md && \
    ln -s /opt/do-md/node_modules/.bin/do-md-mcp /usr/local/bin/do-md-mcp

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
