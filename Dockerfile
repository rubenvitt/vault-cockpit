# Vault Cockpit – Remote-MCP-Server für einen Obsidian-Vault.
# Kein natives Modul nötig: FTS5 kommt aus Nodes eingebautem node:sqlite.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY . .

FROM node:26-alpine
ENV NODE_ENV=production
# Claude Code CLI für Folgen „Podcast“ und „Report“ (src/lesen/claude.js); leer = ohne.
ARG CLAUDE_CODE_VERSION=2.1.309
RUN apk add --no-cache wget && mkdir -p /data && chown node:node /data
# Unter /tmp installieren: Als root nach / hängt die Installation sonst manchmal.
WORKDIR /tmp
RUN if [ -n "$CLAUDE_CODE_VERSION" ]; then \
      apk add --no-cache libgcc libstdc++ ripgrep && \
      npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION" && \
      npm cache clean --force; \
    fi
# Systemeigenes ripgrep statt des mitgelieferten (musl).
ENV USE_BUILTIN_RIPGREP=0 DISABLE_UPDATES=1
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "src/main.js"]
