FROM node:24-bookworm-slim AS build

ARG PNPM_VERSION=11.13.0
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000 \
    NPM_CONFIG_FETCH_TIMEOUT=300000
WORKDIR /workspace

# Corepack's downloader has a fixed, short connection timeout and no retry,
# which makes first builds fragile on distant or temporarily congested npm
# routes. npm honors the retry/timeout settings above; keep the version pinned.
RUN npm install --global "pnpm@${PNPM_VERSION}" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}"

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/media/package.json ./packages/media/package.json
RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
RUN pnpm -r --if-present build

FROM node:24-bookworm-slim AS ffmpeg-build
ARG FFMPEG_VERSION=8.1.2
ARG FFMPEG_SHA256=464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential ca-certificates curl libass-dev libfontconfig1-dev \
        libfreetype6-dev libfribidi-dev libharfbuzz-dev libssl-dev libx264-dev \
        nasm pkg-config xz-utils yasm zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/ffmpeg
RUN curl --fail --location --silent --show-error \
        "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
        --output ffmpeg.tar.xz \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum --check --strict \
    && tar --extract --file ffmpeg.tar.xz --strip-components=1 \
    && ./configure \
        --prefix=/opt/ffmpeg \
        --disable-debug \
        --disable-doc \
        --disable-ffplay \
        --disable-static \
        --enable-shared \
        --enable-gpl \
        --enable-version3 \
        --enable-libass \
        --enable-libfontconfig \
        --enable-libfreetype \
        --enable-libx264 \
        --enable-openssl \
    && make -j"$(nproc)" \
    && make install

FROM node:24-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace /app
USER node
CMD ["node", "apps/api/dist/server.js"]

FROM node:24-bookworm-slim AS worker
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates libass9 libfontconfig1 libfreetype6 libfribidi0 \
        libharfbuzz0b libssl3 libx264-164 zlib1g \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg-build /opt/ffmpeg /opt/ffmpeg
ENV NODE_ENV=production
ENV PATH=/opt/ffmpeg/bin:$PATH
ENV LD_LIBRARY_PATH=/opt/ffmpeg/lib
WORKDIR /app
COPY --from=build /workspace /app
USER node
CMD ["node", "apps/worker/dist/index.js", "work"]

FROM nginx:1.28-alpine AS gateway
RUN apk add --no-cache ca-certificates \
    && addgroup -g 1000 easy-stream \
    && adduser -D -H -u 1000 -G easy-stream easy-stream \
    && sed -i 's/^user[[:space:]][[:space:]]*nginx;/user easy-stream;/' /etc/nginx/nginx.conf \
    && chown -R easy-stream:easy-stream /var/cache/nginx
COPY infra/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY infra/nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
