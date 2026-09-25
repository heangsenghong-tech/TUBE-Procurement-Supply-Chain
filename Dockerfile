# ---- build: install, test-compile and bundle everything ----
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @tube/web build && pnpm --filter @tube/api build

# ---- runtime: one bundled server file + static web app, no node_modules ----
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 \
    MIGRATIONS_DIR=/app/migrations SEED_DIR=/app/seed WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /src/apps/api/dist/index.js ./index.js
COPY --from=build /src/apps/api/src/db/migrations ./migrations
COPY --from=build /src/apps/web/dist ./web
COPY data/seed ./seed
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "index.js"]
