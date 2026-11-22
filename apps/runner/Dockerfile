FROM node:22-bookworm-slim
# bubblewrap and socat are what Claude Code's command sandbox runs on.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates util-linux \
    bubblewrap socat \
    && rm -rf /var/lib/apt/lists/*
# The Agent uses gh as usual. The container holds no GitHub token: the API adds
# the Run's token to GitHub requests outside the container.
ENV TAILOS_GH_VERSION=2.103.3
RUN set -eu; arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sum=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d ;; \
      arm64) sum=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63 ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    name="gh_${TAILOS_GH_VERSION}_linux_${arch}"; \
    node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(r.status); require("node:fs").writeFileSync("/tmp/gh.tgz", Buffer.from(await r.arrayBuffer())); })' \
      "https://github.com/cli/cli/releases/download/v${TAILOS_GH_VERSION}/${name}.tar.gz"; \
    echo "$sum  /tmp/gh.tgz" | sha256sum -c -; \
    tar -xzf /tmp/gh.tgz -C /tmp; \
    install -m 0755 "/tmp/${name}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tgz "/tmp/${name}"
ENV TAILOS_CODEX_VERSION=0.166.0
RUN npm install --global --ignore-scripts @openai/codex@${TAILOS_CODEX_VERSION}
# External bubblewrap resolves this helper through PATH. Codex will not create
# its usual helper aliases when the disposable CODEX_HOME is under /tmp.
RUN codex_binary="$(find /usr/local/lib/node_modules/@openai/codex -type f -path '*/vendor/*/bin/codex')" \
    && test -n "$codex_binary" && test -x "$codex_binary" \
    && ln -s "$codex_binary" /usr/local/bin/codex-linux-sandbox
# Make Tailos's formatting and linting tools available to the Agent offline.
RUN npm install --prefix /opt/tailos-checks --ignore-scripts \
    @pnpm/exe@12.15.0 oxfmt@0.75.0 oxlint@1.89.0
ENV PATH="/opt/tailos-checks/node_modules/.bin:${PATH}"
WORKDIR /app
RUN install -d -o node -g node -m 0700 /app/git-state /app/tls
ENV TAILOS_GIT_STATE_DIR=/app/git-state
# The Agent SDK ships Claude Code as a platform binary, so it stays out of the
# bundle. Keep these versions equal to apps/runner/package.json.
ENV TAILOS_CLAUDE_AGENT_SDK_VERSION=0.3.319
RUN npm install --prefix /app --ignore-scripts --no-save \
    @anthropic-ai/claude-agent-sdk@${TAILOS_CLAUDE_AGENT_SDK_VERSION} zod@4.6.7
COPY --chown=node:node dist/runner.cjs ./runner.cjs
COPY entrypoint.sh /usr/local/bin/tailos-runner
USER node
EXPOSE 8080
# Bubblewrap expects non-root callers to start without inherited capabilities.
CMD ["setpriv", "--inh-caps=-all", "--ambient-caps=-all", "tailos-runner"]
