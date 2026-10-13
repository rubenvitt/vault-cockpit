# Sidecar „vault-sync“: Obsidian Headless (`ob sync --continuous`) für den Vault.
# Eigenes Image statt der Community-Variante, damit die Client-Version gepinnt ist:
# Der Client ist Beta und schreibt bidirektional in den Vault.
FROM node:24-alpine
ARG OBSIDIAN_HEADLESS_VERSION=0.0.14
# better-sqlite3 (Abhängigkeit des Clients) bringt ein Prebuild für musl mit,
# Build-Werkzeuge sind nicht nötig. Sein Install-Skript ausdrücklich erlauben.
RUN npm install -g --no-audit --no-fund --allow-scripts=better-sqlite3 \
      "obsidian-headless@${OBSIDIAN_HEADLESS_VERSION}" \
  && npm cache clean --force \
  && mkdir -p /vault /config /status /app \
  && chown node:node /vault /config /status
ENV NODE_ENV=production \
    NODE_NO_WARNINGS=1 \
    OBSIDIAN_HEADLESS_VERSION=${OBSIDIAN_HEADLESS_VERSION} \
    VAULT_PATH=/vault \
    STATUS_FILE=/status/sync.json \
    XDG_CONFIG_HOME=/config
COPY --chown=node:node entrypoint.mjs status.mjs /app/
# Wie das Cockpit als uid 1000 (node), damit beide dieselben Dateien schreiben dürfen.
USER node
WORKDIR /vault
# Gesund, solange der Wrapper seinen Herzschlag schreibt und der Client läuft.
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "const s=JSON.parse(require('fs').readFileSync(process.env.STATUS_FILE,'utf8'));process.exit(Date.now()-Date.parse(s.heartbeatAt)<120000&&s.state!=='stopped'?0:1)"
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
