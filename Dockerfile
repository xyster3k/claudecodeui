# Builds a custom CloudCLI image from upstream source + local patches.
# Pinning to a known-good upstream commit for reproducibility — bump when validating new upstream releases.

ARG UPSTREAM_COMMIT=f6200e3e95b2f281c08277d5813a0bc7a59a145c  # v1.30.0

FROM node:22-bookworm-slim AS builder
ARG UPSTREAM_COMMIT

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN git clone https://github.com/siteboon/claudecodeui.git . \
 && git checkout "$UPSTREAM_COMMIT"

# Apply local patches (in filename order)
COPY patches/ /tmp/patches/
RUN set -e; for p in /tmp/patches/*.patch; do \
      [ -f "$p" ] || continue; \
      echo "applying $p"; \
      git apply --index "$p"; \
    done

RUN npm install \
 && npm run build \
 && npm prune --omit=dev


FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git bash tmux openssh-client curl ca-certificates \
      python3 sqlite3 \
 && rm -rf /var/lib/apt/lists/*

# Coding CLIs available inside the container
RUN npm install -g --omit=dev \
      @anthropic-ai/claude-code \
      @openai/codex

# Git credential helper: reads active PAT from CloudCLI's SQLite DB.
# Wired at /etc/gitconfig so CloudCLI's UI (which writes ~/.gitconfig) cannot clobber it.
COPY extras/cloudcli-git-credential /usr/local/bin/cloudcli-git-credential
COPY extras/cloudcli-project /usr/local/bin/cloudcli-project
COPY extras/etc-gitconfig /etc/gitconfig
RUN chmod +x /usr/local/bin/cloudcli-git-credential /usr/local/bin/cloudcli-project \
 && chmod 644 /etc/gitconfig

WORKDIR /app
COPY --from=builder /build/package.json /build/package-lock.json ./
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/dist-server ./dist-server
COPY --from=builder /build/server ./server
COPY --from=builder /build/shared ./shared
COPY --from=builder /build/public ./public

RUN chown -R node:node /app

USER node
WORKDIR /home/node
RUN mkdir -p /home/node/.claude /home/node/.codex /home/node/.config/gh /home/node/projects /home/node/.cloudcli

ENV PORT=3001
EXPOSE 3001

CMD ["node", "/app/dist-server/server/index.js"]
