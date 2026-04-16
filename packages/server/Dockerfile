FROM node:20-alpine

WORKDIR /app

# PostGraphile's pg module needs native build tools
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/admin-ui/package.json packages/admin-ui/

RUN pnpm install --frozen-lockfile --prod=false

COPY packages/protocol/ packages/protocol/
COPY packages/server/ packages/server/
COPY packages/admin-ui/ packages/admin-ui/

# Build protocol (server depends on its dist/)
RUN pnpm --filter @vicoop-bridge/protocol build

# Build admin UI (server serves its dist/ as static files)
RUN pnpm --filter @vicoop-bridge/admin-ui build

ENV NODE_ENV=production
ENV PORT=8787
ENV POSTGRAPHILE_PORT=5433
EXPOSE 8787

CMD ["pnpm", "--filter", "@vicoop-bridge/server", "start"]
