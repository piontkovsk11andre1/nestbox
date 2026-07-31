# syntax=docker/dockerfile:1.7

# ---- Stage 1: install PHP dependencies with Composer ----
FROM composer:latest AS vendor

WORKDIR /build
COPY ./home/configs/php/composer.json ./composer.json
COPY ./home/configs/php/composer.lock ./composer.lock
RUN composer install --no-interaction --prefer-dist --optimize-autoloader --no-dev

# ---- Stage 2: runtime ----
FROM php:fpm-alpine

ARG APP_UID=1000
ARG APP_GID=1000

# Required system + PHP extensions.
RUN apk add --no-cache --virtual .build-deps $PHPIZE_DEPS libzip-dev && \
    apk add --no-cache libzip && \
    docker-php-ext-install zip && \
    apk del .build-deps

# PHP config.
COPY ./home/configs/php/php.ini /usr/local/etc/php/conf.d/custom.ini

# Vendor dir from stage 1.
COPY --from=vendor /build/vendor /vendor
COPY ./home/configs/php/composer.json /composer.json
COPY ./home/configs/php/composer.lock /composer.lock

# Application source.
COPY ./home/configs/php /sources/php
COPY ./home/code /home/code

# Run as a non-root, non-default user. UID/GID are passed as build args so
# they can match the host user when bind-mounting in development, avoiding
# the classic "files owned by root after compose down" annoyance on Linux.
RUN addgroup -g "${APP_GID}" -S nestbox && \
    adduser  -u "${APP_UID}" -G nestbox -S -H nestbox && \
    sed -i "s/^user = .*/user = nestbox/; s/^group = .*/group = nestbox/" /usr/local/etc/php-fpm.d/www.conf && \
    chown -R nestbox:nestbox /home/code /sources/php /vendor

USER nestbox
