FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git bash ca-certificates ripgrep python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts @openai/codex@0.166.0
WORKDIR /opt/meguri
COPY dist/runner.mjs ./runner.mjs
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "/opt/meguri/runner.mjs"]
