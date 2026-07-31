FROM node:alpine

ARG APP_UID=1000
ARG APP_GID=1000

RUN apk add --no-cache shadow && \
    if [ "$(id -u node)" != "$APP_UID" ]; then usermod -u "$APP_UID" node; fi && \
    if [ "$(id -g node)" != "$APP_GID" ]; then groupmod -g "$APP_GID" node; fi

COPY ./home/code /home/code
COPY ./home/configs/rollup /sources/rollup

WORKDIR /sources/rollup
RUN npm ci --no-audit --no-fund && chown -R node:node /home/code /sources/rollup

USER node
