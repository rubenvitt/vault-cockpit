# Vault Cockpit

Remote-MCP-Server, der Claude (claude.ai, Claude Desktop, Claude Code) Zugriff
auf einen Obsidian-Vault gibt: lesen, neue Notizen im Posteingang anlegen und
bestehende Notizen gezielt bearbeiten. Reiner OAuth-Resource-Server: [Pocket ID](https://pocket-id.org)
ist der Authorization Server, Claude weist sich per CIMD aus.

Hervorgegangen aus `vault-mcp`; wächst zum Cockpit rund um den Vault (Sync, Capture,
Konnektoren, Web-UI) — siehe [docs/roadmap.md](docs/roadmap.md).

## Was er kann

| Werkzeug | Zweck |
|---|---|
| `vault_search` | Volltextsuche (SQLite FTS5) mit Filtern auf Tag, Ordner und Frontmatter-Typ |
| `vault_read` | Notiz vollständig lesen, mit Fortsetzung bei sehr langen Notizen |
| `vault_list` | Ordner auflisten, zur Orientierung |
| `vault_links` | Backlinks und ausgehende Links einer Notiz |
| `vault_stats` | Kennzahlen des Vaults |
| `vault_capture` | Neue Notiz im Capture-Ordner ablegen (Scope `vault:capture`) |
| `vault_edit` | Exakte Textstelle in einer Notiz ersetzen oder löschen (Scope `vault:edit`) |
| `vault_append` | Text am Notizende oder unter einer Überschrift anhängen (Scope `vault:edit`) |
| `vault_set_frontmatter` | Einzelne Frontmatter-Felder setzen oder entfernen (Scope `vault:edit`) |

## Betrieb

Das Image baut GitHub Actions bei jedem Push auf `main`:
`ghcr.io/rubenvitt/vault-cockpit:latest` (zusätzlich `:<commit-sha>`).

1. `docker-compose.example.yml`, `.env.example` und `policy.example.json` neben
   den Stack kopieren (ohne `.example`) und anpassen.
2. In Pocket ID unter *Allowed metadata document URLs*
   `https://claude.ai/oauth/mcp-oauth-client-metadata` freischalten und eine API
   mit der Resource `<PUBLIC_URL>/mcp` anlegen. Der Scope `vault:edit` muss dort
   genauso freigegeben sein wie `vault:capture`; ein bestehender Connector muss
   danach in Claude neu verbunden werden, damit das Token ihn trägt.
3. `docker compose up -d`, dann in Claude einen Connector auf `<PUBLIC_URL>/mcp`.

| Variable | Bedeutung |
|---|---|
| `PUBLIC_URL` | öffentliche Adresse, Pflicht |
| `OIDC_ISSUER` | Pocket-ID-Issuer, Pflicht |
| `POLICY_FILE` | Pfad zur Policy (vertrauliche Ordner, Ausschlüsse) |
| `ALLOWED_SUBJECTS` | optionale Einschränkung auf `sub`-Werte |
| `VAULT_PATH`, `INDEX_DB`, `CAPTURE_FOLDER` | Pfade, Standard `/vault`, `/data/index.db`, `inbox` |
| `REINDEX_INTERVAL_MIN` | Abstand der Index-Neuaufbauten, Standard 15 |

Tests, ohne laufenden Container:
```bash
npm ci && npm test
```

## Aufbau

- `src/oauth/` — Token-Prüfung (RFC 9068, Audience-Bindung), Principal-Cache
- `src/vault/` — Markdown-Parser, SQLite-FTS5-Index, Link-Graph, Policy, Capture, Bearbeiten
- `src/mcp/` — MCP-Werkzeuge auf Basis von `@modelcontextprotocol/server` v2
- `src/http/` — HTTP-Schicht, Protected Resource Metadata, Host-Prüfung

## Sicherheitsentscheidungen

- **Bearbeiten nur lokal und nur mit eigenem Scope:** Es gibt kein „Datei komplett
  überschreiben“ — nur Textstelle ersetzen (muss eindeutig sein), anhängen und
  einzelne Frontmatter-Felder setzen. Bearbeitbar ist nur, was im Index steht:
  ausgeschlossene Pfade, vertrauliche Ordner, Readwise-Importe und alles außer
  `.md` bleiben gesperrt. Ändert Obsidian Sync die Datei zwischen Lesen und
  Schreiben, wird abgebrochen statt überschrieben.
- **Schreibgrenze wählbar über den Mount:** Zum Bearbeiten ist der Vault
  beschreibbar gemountet; die frühere Garantie „ein Code-Fehler kann keine
  bestehende Notiz verändern“ gilt damit nicht mehr. Wer sie zurück will, mountet
  den Vault wieder `:ro` (siehe `docker-compose.example.yml`) — die
  Bearbeitungswerkzeuge melden dann den Schreibschutz, Capture funktioniert weiter.
  Als Netz bleibt die Versionshistorie von Obsidian Sync.
- **Vertrauliche Ordner** werden indexiert, aber nur auf ausdrückliche Anforderung
  ausgeliefert. Welche das sind, steht in der Policy-Datei auf dem Server, nicht
  im Code.
- **Audience-Bindung:** Akzeptiert werden nur Tokens, deren `aud` exakt
  `<PUBLIC_URL>/mcp` enthält. Ein reines Login-Token kommt damit nicht durch —
  der von der MCP-Spec geforderte Schutz gegen Token-Passthrough.
- **Kein eigener Authorization Server:** Login, Consent, Refresh und Widerruf
  liegen vollständig bei Pocket ID.
- **Readwise-Importe** sind eine eigene Indexklasse und standardmäßig aus der Suche
  ausgenommen, damit importierte Fremdtexte die eigenen Notizen nicht verdrängen.

Hintergrund und Entscheidungen: `docs/design.md`.
