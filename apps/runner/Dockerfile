FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts @openai/codex@0.166.0
WORKDIR /app
RUN install -d -o node -g node -m 0700 /app/git-state
ENV MEGURI_GIT_STATE_DIR=/app/git-state
COPY --chown=node:node dist/runner.mjs ./runner.mjs
USER node
EXPOSE 8080
# Bubblewrap expects non-root callers to start without inherited capabilities.
CMD ["setpriv", "--inh-caps=-all", "--ambient-caps=-all", "node", "runner.mjs"]
