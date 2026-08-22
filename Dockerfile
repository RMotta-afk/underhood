# Underhood — multi-stage build on the mandated Bun runtime.
FROM oven/bun:1.3.14 AS base
WORKDIR /app

FROM base AS deps
ENV HUSKY=0
COPY package.json bun.lock ./
COPY packages/types/package.json packages/types/
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
# Build-time quality gate: strict static analysis + schema tests must pass in-image.
RUN bun run typecheck && bun test

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
# Backend entrypoint (Mastra workflow + pg-boss worker + async API land in G2/G5).
CMD ["bun", "run", "backend/src/index.ts"]
