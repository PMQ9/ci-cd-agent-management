# Multi-stage build for the control plane. Build context is the repo root.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/control-plane/package.json packages/control-plane/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json
RUN pnpm install --no-frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @agentpr/dashboard build \
 && pnpm --filter @agentpr/control-plane build

FROM base AS runtime
ENV NODE_ENV=production
ENV DASHBOARD_DIST=/app/packages/dashboard/dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/control-plane/dist ./packages/control-plane/dist
# The pnpm symlink tree where the control-plane's own deps (drizzle-orm, etc.)
# resolve. Without this the container crashes on boot with ERR_MODULE_NOT_FOUND.
COPY --from=build /app/packages/control-plane/node_modules ./packages/control-plane/node_modules
COPY --from=build /app/packages/control-plane/drizzle ./packages/control-plane/drizzle
COPY --from=build /app/packages/control-plane/package.json ./packages/control-plane/package.json
COPY --from=build /app/packages/dashboard/dist ./packages/dashboard/dist
RUN useradd -r -u 1001 app && chown -R app:app /app
USER app
WORKDIR /app/packages/control-plane
EXPOSE 8080
CMD ["node", "dist/index.js"]
