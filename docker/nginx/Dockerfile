# syntax=docker/dockerfile:1.7

# ---- Stage 1: build the JS/CSS bundles with Rollup ----
FROM node:alpine AS bundles

WORKDIR /sources/rollup
COPY ./home/configs/rollup/package.json ./package.json
COPY ./home/configs/rollup/package-lock.json ./package-lock.json
RUN npm ci --no-audit --no-fund

COPY ./home/configs/rollup/rollup.config.js ./rollup.config.js
COPY ./home/code /home/code
RUN npx rollup -c

# ---- Stage 2: runtime ----
FROM alpine:3.23

RUN apk add --no-cache nginx nginx-mod-http-nchan && \
    mkdir -p /run/nginx /var/lib/nginx/tmp

COPY ./home/configs/nginx/nginx.conf /etc/nginx/nginx.conf
COPY ./home/code /var/www/html
# Overwrite the source bundles with the freshly built ones from stage 1.
COPY --from=bundles /home/code/scripts-bundle.js  /var/www/html/scripts-bundle.js
COPY --from=bundles /home/code/scripts-bundle.css /var/www/html/scripts-bundle.css

EXPOSE 80 8080

STOPSIGNAL SIGQUIT

CMD ["nginx", "-g", "daemon off;"]
