# syntax=docker/dockerfile:1
# Build from the repository root (the image includes the pages from web/):
#   docker build -f app/Dockerfile .

# ---- web: build the browser pages ----
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/tsconfig.json web/tsconfig.node.json web/vite.config.ts web/*.html ./
COPY web/src ./src
RUN npm run build

# ---- build: compile the API, then drop dev dependencies ----
FROM node:22-alpine AS build
WORKDIR /app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/tsconfig.json app/tsconfig.build.json ./
COPY app/src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: production dependencies, compiled API and built pages only ----
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_ROOT=/app/public
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./public
# The built-in unprivileged "node" user (uid 1000); files stay root-owned and read-only.
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/index.js"]
