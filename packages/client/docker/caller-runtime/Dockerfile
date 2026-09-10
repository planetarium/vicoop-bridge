# Supply an immutable base digest and exact Claude package version at build time.
ARG NODE_IMAGE=node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
FROM ${NODE_IMAGE}
ARG CLAUDE_VERSION
RUN test -n "$CLAUDE_VERSION" && \
    npm install --engine-strict --global "@anthropic-ai/claude-code@$CLAUDE_VERSION" && \
    npm cache clean --force && \
    claude --version
# No VOLUME declaration: state is supplied as bounded tmpfs by the manager.
# Image tooling is shared read-only; no operator config or credentials are copied.
USER 1000:1000
WORKDIR /state/workspace
ENTRYPOINT ["claude"]
