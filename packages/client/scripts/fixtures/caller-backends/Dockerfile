FROM ghcr.io/planetarium/vicoop-runtime:latest
USER root
COPY packages/client/scripts/fixtures/caller-backends/backend.cjs /usr/local/lib/caller-fixture.cjs
RUN printf '#!/bin/sh\nexec /usr/local/bin/node /usr/local/lib/caller-fixture.cjs claude "$@"\n' > /usr/local/bin/claude \
 && printf '#!/bin/sh\nexec /usr/local/bin/node /usr/local/lib/caller-fixture.cjs codex "$@"\n' > /usr/local/bin/codex \
 && chmod 755 /usr/local/bin/claude /usr/local/bin/codex \
 && mkdir -p /workspace /data/sessions/claude/config /data/sessions/codex/config \
 && chown -R node:node /workspace /data/sessions
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
USER node
WORKDIR /workspace
