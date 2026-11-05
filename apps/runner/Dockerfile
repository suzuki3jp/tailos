FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts @openai/codex@0.166.0
WORKDIR /app
COPY --chown=node:node dist/runner.mjs ./runner.mjs
USER node
EXPOSE 8080
CMD ["node", "runner.mjs"]
