# Vault Cockpit – Remote-MCP-Server für einen Obsidian-Vault.
# Kein natives Modul nötig: FTS5 kommt aus Nodes eingebautem node:sqlite.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY . .

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache wget && mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "src/main.js"]
