# syntax=docker/dockerfile:1.7
#
# One Dockerfile, three images. Build a target with:
#   docker build --target api    -t fdv/api    .
#   docker build --target worker -t fdv/worker .
#   docker build --target web    -t fdv/web    .
# docker-compose.yml does this for you.

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=9.15.9

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app

# ---------------------------------------------------------------- manifests
# Only package manifests, so the dependency layer is cached until they change.
FROM base AS manifests
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/db/package.json packages/db/

# ---------------------------------------------------------------- build
FROM manifests AS build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json ./
COPY scripts scripts
COPY packages packages
COPY apps apps
RUN pnpm -r build

# ---------------------------------------------------------------- prod-deps
# Runtime dependencies only, for the two Node services.
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @fdv/api --filter @fdv/worker

# ---------------------------------------------------------------- api
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production \
    FDV_MIGRATIONS_DIR=/app/migrations \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/migrations ./migrations
# The local vault lives on a volume mounted here. A named volume takes its
# ownership from the image's directory on first use, so it must belong to
# the unprivileged user before we drop privileges.
RUN mkdir -p /data/vault && chown -R node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/readyz >/dev/null || exit 1
CMD ["node", "apps/api/dist/server.mjs"]

# ---------------------------------------------------------------- worker
FROM ${NODE_IMAGE} AS worker
ENV NODE_ENV=production \
    FDV_MIGRATIONS_DIR=/app/migrations
# OCR and rendering tools: Tesseract 5 (English), poppler (PDF pages and
# page counts), ImageMagick (thumbnails). All offline.
# Fonts matter: without them poppler renders text-only PDFs blank, and OCR
# reads nothing.
RUN apk add --no-cache tesseract-ocr tesseract-ocr-data-eng poppler-utils imagemagick     fontconfig font-dejavu font-liberation postgresql16-client     && fc-cache -f && magick -version >/dev/null && tesseract --version >/dev/null     && pg_dump --version >/dev/null
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY apps/worker/package.json ./apps/worker/package.json
COPY scripts/restore-drill.sh ./scripts/restore-drill.sh
# A restore brings an older backup up to date, as the API's start would.
COPY packages/db/migrations ./migrations
RUN mkdir -p /data/vault /data/backups && chown -R node:node /data
USER node
CMD ["node", "apps/worker/dist/main.mjs"]

# ---------------------------------------------------------------- web
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
