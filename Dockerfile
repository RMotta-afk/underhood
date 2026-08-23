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
# Frontend production bundle; empty API base => same-origin /analyses via proxy.
ENV NEXT_PUBLIC_API_BASE_URL=""
ENV NEXT_TELEMETRY_DISABLED=1
RUN bun run --filter '@underhood/frontend' build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
# 3000 = backend API/worker, 3001 = Next.js frontend (SDD §7.2 single app service).
EXPOSE 3000 3001
CMD ["bun", "run", "scripts/start-stack.ts"]
