FROM node:20-alpine

WORKDIR /app

# PostGraphile's pg module needs native build tools
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay/package.json packages/relay/
COPY packages/connector/package.json packages/connector/

RUN pnpm install --frozen-lockfile --prod=false

COPY packages/protocol/ packages/protocol/
COPY packages/relay/ packages/relay/

# Build protocol (relay depends on its dist/)
RUN pnpm --filter @vicoop-bridge/protocol build

ENV NODE_ENV=production
ENV PORT=8787
ENV POSTGRAPHILE_PORT=5433
EXPOSE 8787

CMD ["pnpm", "--filter", "@vicoop-bridge/relay", "start"]
