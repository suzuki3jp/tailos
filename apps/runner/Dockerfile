FROM node:22-bookworm-slim
# bubblewrap and socat are what Claude Code's command sandbox runs on.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates util-linux \
    bubblewrap socat \
    && rm -rf /var/lib/apt/lists/*
ENV TAILOS_CODEX_VERSION=0.166.0
RUN npm install --global --ignore-scripts @openai/codex@${TAILOS_CODEX_VERSION}
# Make Tailos's formatting and linting tools available to the Agent offline.
RUN npm install --prefix /opt/tailos-checks --ignore-scripts \
    @pnpm/exe@12.15.0 oxfmt@0.75.0 oxlint@1.89.0
ENV PATH="/opt/tailos-checks/node_modules/.bin:${PATH}"
WORKDIR /app
RUN install -d -o node -g node -m 0700 /app/git-state
ENV TAILOS_GIT_STATE_DIR=/app/git-state
# The Agent SDK ships Claude Code as a platform binary, so it stays out of the
# bundle. Keep these versions equal to apps/runner/package.json.
ENV TAILOS_CLAUDE_AGENT_SDK_VERSION=0.3.319
RUN npm install --prefix /app --ignore-scripts --no-save \
    @anthropic-ai/claude-agent-sdk@${TAILOS_CLAUDE_AGENT_SDK_VERSION} zod@4.6.7
COPY --chown=node:node dist/runner.cjs ./runner.cjs
USER node
EXPOSE 8080
# Bubblewrap expects non-root callers to start without inherited capabilities.
CMD ["setpriv", "--inh-caps=-all", "--ambient-caps=-all", "node", "runner.cjs"]
