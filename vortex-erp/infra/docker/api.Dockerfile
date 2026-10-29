FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter "./packages/*" build && pnpm --filter @vortex/api build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production STORAGE_DIR=/app/storage
COPY --from=build /app /app
USER node
EXPOSE 3333
CMD ["node", "apps/api/dist/src/server.js"]
