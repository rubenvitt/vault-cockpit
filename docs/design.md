# Vault Cockpit — Design

Remote-MCP-Server für einen Obsidian-Vault, gedacht für claude.ai / Claude Desktop.
Beispielnamen unten: `mcp.example.com` (dieser Server), `id.example.com` (Pocket ID).

## Entscheidungen

| Frage | Entscheidung |
|---|---|
| Clients | nur claude.ai / Claude Desktop |
| Rechte | Lesen, Capture (neue Dateien in `inbox/`), Bearbeiten bestehender Notizen — je eigener Scope |
| Suche | SQLite FTS5, lokaler Index, kein externer Dienst |
| Auth | **Reiner Resource Server**, Pocket ID ist der Authorization Server |
| Client-Registrierung | **CIMD** (Client ID Metadata Documents), nicht DCR |
| Laufzeit | Node 26, `node:sqlite` (FTS5 verifiziert), keine nativen Module |
| Deployment | Docker-Image aus GitHub Actions (`ghcr.io`), hinter Traefik |

## Auth-Architektur

```
Claude ──(1) POST /mcp ──────────────────────► 401 + WWW-Authenticate(resource_metadata)
Claude ──(2) GET  /.well-known/oauth-protected-resource/mcp ─► PRM: authorization_servers = [id.example.com]
Claude ──(3) GET  id.example.com/.well-known/oauth-authorization-server ─► AS-Metadata
Browser ─(4) GET  id.example.com/authorize
              client_id=https://claude.ai/oauth/mcp-oauth-client-metadata   ← CIMD statt DCR
              resource=https://mcp.example.com/mcp                           ← RFC 8707
              PKCE S256
Browser ─(5) Passkey-Login ───────────────────► claude.ai/api/mcp/auth_callback?code=…
Claude ──(6) POST id.example.com/api/oidc/token ─► RFC-9068-JWT, aud = https://mcp.example.com/mcp
Claude ──(7) POST /mcp mit Bearer ────────────► wir prüfen Signatur, iss, aud, exp
```

**Wir stellen keine Tokens aus.** Alles rund um Login, Consent, Refresh und
Widerruf liegt bei Pocket ID. Unser Anteil ist die Protected Resource Metadata
und die Token-Prüfung — das entspricht der Arbeitsteilung, die die MCP-Spec
2026-07-28 vorsieht und die auch das offizielle `pocket-id/mcp-oauth-demo` zeigt.

### Warum nicht mehr der eigene Authorization Server

Die erste Fassung war ein eigener AS mit Dynamic Client Registration. Drei
Gründe sprechen dagegen, belegt durch Recherche:

- Das MCP-SDK v2 hat seine AS-Helfer eingefroren („Use a dedicated identity
  provider for new servers; this page only covers the resource-server half").
- **DCR gilt in der Spec 2026-07-28 als deprecated**, Nachfolger ist CIMD.
  Pocket ID hat DCR bewusst abgelehnt (Issue #1517, `not_planned`).
- Pocket ID 2.14 kann RFC 8707 nativ. Die Audience-Bindung, wegen der der
  eigene AS ursprünglich nötig schien, entsteht dort korrekt von selbst.

Ergebnis: gut 400 Zeilen sicherheitskritischer OAuth-Code entfallen ersatzlos.

### Audience-Bindung — der entscheidende Punkt

Pocket ID setzt `aud` abhängig vom `resource`-Parameter:

| Anfrage | `aud` im Token |
|---|---|
| ohne `resource` | die `client_id` — ein reines Login-Token |
| mit `resource=https://mcp.example.com/mcp` | unsere Resource (+ Issuer bei Identity-Scopes) |

Der Verifier akzeptiert **nur** Tokens, deren `aud` unsere Resource enthält. Ein
Login-Token für einen anderen Dienst kommt damit nicht durch — das ist der von
der Spec geforderte Schutz gegen Token-Passthrough.

### Zugriffskontrolle

Der `groups`-Claim steckt bei Pocket ID **nicht** im Access Token, sondern nur
im ID-Token und in `/userinfo`. Die Gruppenprüfung gehört deshalb dorthin, wo
sie hingehört: an den Client in Pocket ID (`isGroupRestricted` + eine eigene Gruppe).
Verifiziert im Quellcode: die Prüfung `IsUserGroupAllowedToAuthorize` ist
generisch und greift auch für CIMD-Clients, und ein Metadaten-Refresh setzt sie
nicht zurück (`store.go:279` aktualisiert die Felder nicht).

Optional zusätzlich: `ALLOWED_SUBJECTS` schränkt auf einzelne `sub`-Werte ein.

## Schreibrecht-Design

Drei Stufen, jede mit eigenem Scope:

| Scope | Darf |
|---|---|
| `vault:read` | suchen, lesen, auflisten |
| `vault:capture` | neue Dateien in `inbox/` anlegen, nie überschreiben |
| `vault:edit` | bestehende Notizen ändern: Textstelle ersetzen, anhängen, Frontmatter-Felder, in einen Ordner verschieben |

### Bearbeiten

Ursprünglich war der Vault read-only gemountet und nur der Capture-Ordner
schreibbar — die Schreibgrenze lag im Dateisystem. Bearbeiten braucht einen
schreibbaren Vault; die Grenze liegt damit im Code. Ausgeglichen wird das so:

- **Nur lokale Operationen.** Kein „Datei komplett überschreiben“. `vault_edit`
  verlangt eine eindeutige Textstelle (sonst Abbruch mit Anzahl der Treffer),
  `vault_append` fügt nur ein, `vault_set_frontmatter` tauscht nur die genannten
  Schlüsselblöcke. Ein Fehler kann so nicht den Rest einer Notiz mitreißen.
- **Nur, was im Index steht.** Ziel muss eine indexierte `.md`-Datei sein. Damit
  wirken `exclude` der Policy, Pfad-Traversal-Schutz und die Beschränkung auf
  Markdown automatisch. Vertrauliche Ordner und Readwise sind zusätzlich gesperrt
  — auch mit `allow_sensitive`. Ein nachträglich untergeschobener Symlink, der
  aus dem Vault zeigt, wird per `realpath` abgewiesen.
- **Keine verlorenen Sync-Änderungen.** Unmittelbar vor dem Schreiben wird die
  Datei erneut gelesen; weicht sie ab, bricht die Operation ab.
- **Verschieben ohne Überschreiben.** `vault_move` legt wie das Ablegen im
  Cockpit nur eigene Notizen ab, nie in oder aus vertraulichen, ausgeschlossenen
  oder Readwise-Ordnern, und nie auf eine vorhandene Datei. Wikilinks werden
  nicht umgeschrieben; die Antwort nennt die Notizen, deren Links per Pfad (beim
  Umbenennen auch per Name) danach ins Leere zeigen.
- **Index bleibt stimmig.** Nach dem Schreiben wird die eine Notiz neu indexiert
  (Suche, Frontmatter, ausgehende Links); der periodische Komplettaufbau bleibt.
- **Frontmatter ohne YAML-Bibliothek.** Unbekannte Felder und Formatierungen
  bleiben zeilengenau erhalten. Werte, die YAML anders lesen würde (`true`,
  `42`, `a: b`, `[[Link]]`), werden gequotet; deutsche Alias-Schlüssel
  (`typ` ↔ `type`) werden erkannt statt dupliziert.

Wer die Dateisystem-Grenze zurück will, mountet den Vault wieder `:ro` mit dem
Capture-Ordner `:rw` darüber. Die Bearbeitungswerkzeuge melden dann den
Schreibschutz; alles andere läuft unverändert.

## Limits, die die Tools einhalten

- Tool-Ergebnis ≤ 150.000 Zeichen (Claude.ai/Desktop); wir kappen bei 120.000
- Tool-Name ≤ 64 Zeichen
- Jedes Tool trägt `title` und `readOnlyHint` bzw. `destructiveHint`
  (die Bearbeitungswerkzeuge sind `destructiveHint: true`, damit Clients vor dem
  Ausführen nachfragen können)
- Große Treffermengen werden paginiert

## Vertrauliche Ordner und Ausschlüsse

Welche Ordner vertraulich sind, steht **nicht im Code**, sondern in einer
JSON-Datei, die nur auf dem Server liegt (`POLICY_FILE`, Vorlage
`policy.example.json`). Die Ordnernamen selbst verraten sonst, wo die
schützenswerten Notizen liegen.

- `exclude` — Regex auf den relativen Pfad; Treffer kommen nie in den Index.
- `sensitive` — indexiert, aber nur mit `include_sensitive` / `allow_sensitive`
  ausgeliefert, `vault_list` zeigt sie nie, und bearbeitet werden sie nie.
- `readwise` — importierte Fremdtexte als eigene Indexklasse, standardmäßig nicht
  durchsucht, nicht bearbeitbar; ihre `[[…]]` gelten nicht als Links.
- `layoutHint` — erklärt Claude in `vault_list` die Ordnerstruktur.

Ohne `POLICY_FILE` ist nichts vertraulich und nichts ausgeschlossen (außer
`.obsidian/`, `.git/`, `node_modules/`) — der Server warnt beim Start.
