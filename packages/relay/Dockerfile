FROM node:20-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay/package.json packages/relay/
COPY packages/connector/package.json packages/connector/

RUN pnpm install --frozen-lockfile --prod=false

COPY packages/protocol/ packages/protocol/
COPY packages/relay/ packages/relay/

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["pnpm", "--filter", "@vicoop-bridge/relay", "start"]
