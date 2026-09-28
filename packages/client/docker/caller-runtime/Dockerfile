FROM node:22-bookworm-slim
ARG CLAUDE_VERSION=2.1.267
ARG CODEX_VERSION=0.153.4
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl jq tini iptables iproute2 procps \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @openai/codex@${CODEX_VERSION} \
 && case "$(uname -m)" in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) exit 1 ;; esac \
 && npm install -g "@openai/codex-linux-${arch}@npm:@openai/codex@${CODEX_VERSION}-linux-${arch}" \
 && npm cache clean --force
COPY container/backends/claude.sh /tmp/install-claude.sh
RUN AGENT_DIR=/opt/claude bash -c '. /tmp/install-claude.sh; backend_install "$CLAUDE_VERSION"' \
 && ln -s /opt/claude/bin/claude /usr/local/bin/claude \
 && rm /tmp/install-claude.sh \
 && claude --version && codex --version
RUN mkdir -p /workspace /data/sessions/claude/config /data/sessions/codex/config \
 && chown -R node:node /workspace /data/sessions
ENV DISABLE_AUTOUPDATER=1
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/bin/sleep", "infinity"]
