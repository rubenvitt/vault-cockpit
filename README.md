# Vault Cockpit

Remote-MCP-Server, der Claude (claude.ai, Claude Desktop, Claude Code) Zugriff
auf einen Obsidian-Vault gibt: lesen, neue Notizen im Posteingang anlegen und
bestehende Notizen gezielt bearbeiten. Reiner OAuth-Resource-Server: [Pocket ID](https://pocket-id.org)
ist der Authorization Server, Claude weist sich per CIMD aus.

Hervorgegangen aus `vault-mcp`; wächst zum Cockpit rund um den Vault (Sync, Capture,
Konnektoren, Web-UI) — siehe [docs/roadmap.md](docs/roadmap.md).

## Was er kann

Alle Lesewerkzeuge verlangen den Scope `vault:read`.

| Werkzeug | Zweck |
|---|---|
| `vault_search` | Hybride Suche (Volltext + Bedeutung + Link-Graph) oder reine Volltextsuche, mit Filtern auf Tag, Ordner und Frontmatter-Typ |
| `vault_similar` | Inhaltlich ähnliche Notizen, mit Markierung, ob schon verlinkt |
| `vault_graph` | Graph um eine Notiz: Links, ähnliche Notizen, Zunder-Aufgaben, Termine |
| `vault_read` | Notiz vollständig lesen, mit Fortsetzung bei sehr langen Notizen |
| `vault_list` | Ordner auflisten, zur Orientierung |
| `vault_links` | Backlinks und ausgehende Links einer Notiz |
| `vault_stats` | Kennzahlen des Vaults, Zustand des Syncs und des Index |
| `vault_capture` | Neue Notiz im Capture-Ordner ablegen (Scope `vault:capture`) |
| `vault_edit` | Exakte Textstelle in einer Notiz ersetzen oder löschen (Scope `vault:edit`) |
| `vault_append` | Text am Notizende oder unter einer Überschrift anhängen (Scope `vault:edit`) |
| `vault_set_frontmatter` | Einzelne Frontmatter-Felder setzen oder entfernen (Scope `vault:edit`) |

## Betrieb

Das Image baut GitHub Actions bei jedem Push auf `main`:
`ghcr.io/rubenvitt/vault-cockpit:latest` (zusätzlich `:<commit-sha>`).

1. `docker-compose.example.yml`, `.env.example`, `sync.env.example` und
   `policy.example.json` neben den Stack kopieren (ohne `.example`) und anpassen.
   Die Ordner `data`, `sync-config` und `sync-status` anlegen und uid 1000 geben
   (`mkdir -p data sync-config sync-status && chown 1000:1000 data sync-config sync-status`).
2. In Pocket ID unter *Allowed metadata document URLs*
   `https://claude.ai/oauth/mcp-oauth-client-metadata` freischalten und eine API
   mit der Resource `<PUBLIC_URL>/mcp` anlegen. An der API CIMD-Clients zulassen
   und die Berechtigungen `vault:read` (alle Lesewerkzeuge), `vault:capture` und
   `vault:edit` anlegen, jede mit Freigabe für CIMD-Clients. Fehlt eine davon,
   lehnt Pocket ID das Verbinden mit `invalid_scope` ab, weil Claude alle drei
   anfordert. Ein bestehender Connector behält die Scopes seiner ersten Anmeldung
   und muss nach einer Änderung in Claude neu verbunden werden.
3. Sync einrichten (siehe [Sync](#sync)), dann `docker compose up -d` und in
   Claude einen Connector auf `<PUBLIC_URL>/mcp`.

| Variable | Bedeutung |
|---|---|
| `PUBLIC_URL` | öffentliche Adresse, Pflicht |
| `OIDC_ISSUER` | Pocket-ID-Issuer, Pflicht |
| `POLICY_FILE` | Pfad zur Policy (vertrauliche Ordner, Ausschlüsse) |
| `ALLOWED_SUBJECTS` | Pocket-ID-`sub`-Werte mit Zugriff, Pflicht |
| `VAULT_PATH`, `INDEX_DB`, `CAPTURE_FOLDER` | Pfade, Standard `/vault`, `/data/index.db`, `inbox` |
| `REINDEX_INTERVAL_MIN` | Abstand der vollen Index-Neuaufbauten, Standard 15 (Netz neben der Dateibeobachtung) |
| `SYNC_ADAPTER` | `obsidian-headless` (Standard) oder `none` (keine Dateibeobachtung, kein Sync-Status) |
| `SYNC_STATUS_FILE` | Statusdatei des Sync-Sidecars, z. B. `/sync-status/sync.json` |
| `CAPTURE_TOKEN` | Token für `/capture` und `/funke` (ohne Wert sind beide aus), siehe [Capture](#capture) |
| `SEARCH_TOKEN` | Token für `GET /api/search` (ohne Wert aus), siehe [Suche](#suche) |
| `ZUNDER_URL`, `ZUNDER_TOKEN` | Zunder-Adresse und API-Token `zt_…`; ohne Wert keine `!`-Weiterleitung und keine Brücke |
| `ZUNDER_BRIDGE`, `ZUNDER_BRIDGE_TAG` | Zunder-Brücke `on` (Standard, sobald Zunder eingerichtet ist) oder `off`; Tag, Standard `zunder` |
| `OBSIDIAN_VAULT_NAME` | Name des Vaults in Obsidian, für „In Obsidian öffnen“ in Zunder (optional) |
| `CAPTURE_STATE_FILE` | Merkzettel gegen doppelte Aufgaben, Standard `/data/capture-state.json` |
| `MAIL_JMAP_TOKEN` | Fastmail-API-Token (nur Mail); ohne Wert kein Mail-Abruf |
| `MAIL_ALLOWED_SENDERS` | eigene Absenderadressen (Komma-Liste), `@domain` erlaubt eine ganze Domain ohne Subdomains (z. B. `@rubeen.dev,@rubeen.email`); Pflicht mit `MAIL_JMAP_TOKEN` |
| `EMBED_URL`, `EMBED_MODEL` | Ollama-Server für Embeddings (z. B. `http://ollama:11434`) und Modell, Standard `bge-m3`; ohne `EMBED_URL` nur Volltext |
| `VECTOR_DB` | Vektorspeicher, Standard `/data/vectors.db` |
| `MAIL_MAILBOX`, `MAIL_DONE_MAILBOX`, `MAIL_POLL_MIN` | Ordner zum Abholen (Standard `Vault`), Ablage danach (Standard `Archive`), Abstand in Minuten (Standard 5) |

### Sync

Den Vault-Ordner hält der Sidecar `vault-sync` aktuell: [Obsidian Headless](https://www.npmjs.com/package/obsidian-headless)
(`ob sync --continuous`) in einem eigenen Image `ghcr.io/rubenvitt/vault-cockpit-sync`,
dessen Tag die gepinnte Client-Version ist (`sync/Dockerfile`). Er teilt sich den
Vault-Ordner mit dem Cockpit und schreibt nebenbei eine Statusdatei. Das Cockpit
beobachtet den Ordner, liest geänderte Notizen einzeln neu ein und zeigt den Zustand
des Syncs in `vault_stats` (`synced`, `syncing`, `error`, `stale` …, letzter Abgleich,
letzter Fehler).

Einmalig:

1. Anmelden, das Token landet in `./sync-config`:
   `docker compose run --rm -it --entrypoint ob vault-sync login`
   (alternativ `OBSIDIAN_AUTH_TOKEN` in `sync.env` setzen).
2. Den Namen des Remote-Vaults nachsehen
   (`docker compose run --rm --entrypoint ob vault-sync sync-list-remote`) und als
   `VAULT_NAME` in `sync.env` eintragen. Beim ersten Start verknüpft der Sidecar
   den Ordner mit diesem Vault; danach ist `VAULT_NAME` ohne Wirkung.

**Umstieg vom Sync auf dem Host:** Es darf nur ein Sync pro Ordner laufen. Erst den
Host-Dienst stoppen und abschalten, dann den Sidecar starten:

```bash
systemctl --user disable --now obsidian-sync
docker compose up -d vault-sync
docker compose logs -f vault-sync   # bis „Fully synced“
```

Obsidian Headless sperrt den Ordner zusätzlich über `.obsidian/.sync.lock`; ein
zweiter Client auf demselben Ordner bricht mit „Another sync instance is already
running“ ab. Der Sidecar legt eine eigene Sync-Verknüpfung an, der erste Abgleich
vergleicht deshalb den ganzen Ordner (Konflikte nach `CONFLICT_STRATEGY`, Standard
`merge`).

**Client aktualisieren:** `OBSIDIAN_HEADLESS_VERSION` in `sync/Dockerfile` anheben.
Nach dem Merge baut CI das Image mit der neuen Version als Tag; danach den Tag in
der Compose-Datei des Servers nachziehen.

### Capture

Alles, was von außen kommt, landet an einer Stelle: als neue Notiz im
Capture-Ordner (`CAPTURE_FOLDER`) oder, mit `!` am Anfang, als Aufgabe in der
**Zunder-Inbox**. Aufgaben legt das Cockpit nicht selbst ab, es leitet sie an
Zunder weiter (MCP-Werkzeug `create_task`). Dafür in der Zunder-Web-UI unter
**Tokens** einen API-Token anlegen (Name z. B. `vault-cockpit`) und als
`ZUNDER_TOKEN` setzen. Ein Eingangs-Token (`zi_…`) reicht nicht, Eingänge
schreiben nur in ein festes Projekt.

| Weg | So geht's |
|---|---|
| iOS-Kurzbefehl | `POST <PUBLIC_URL>/capture?source=ios-kurzbefehl` mit dem Text als Body, Header `Authorization: Bearer <CAPTURE_TOKEN>` |
| Sprachmemo | Kurzbefehl mit „Audio aufnehmen“ und „Audio transkribieren“ auf dem iPhone, dann wie oben mit `source=sprachmemo`. Transkribiert wird auf dem Gerät, das Cockpit bekommt nur Text. |
| Funke | Als Relay-URL `<PUBLIC_URL>/funke` und als Relay-Token den `CAPTURE_TOKEN` eintragen. Notizen landen im Capture-Ordner (der Ordner aus der App wird ignoriert), Aufgaben schickt Funke weiter direkt an Zunder. |
| Mail | Eine Adresse (Alias) anlegen und per Regel in den Ordner `MAIL_MAILBOX` sortieren. Betreff = Titel, `!` im Betreff = Aufgabe. Verarbeitete Mails wandern nach `MAIL_DONE_MAILBOX`. |

`POST /capture` nimmt Klartext oder JSON `{"text", "title"?, "source"?, "id"?}`.
Mit `id` ist das Anlegen idempotent (dieselbe ID → `200` mit dem Ergebnis von
damals). Antworten: `201 {"kind":"note","path"}` bzw.
`201 {"kind":"task","id","ref","url"}`, `400` bei falscher Eingabe, `401` ohne
gültigen Token, `502` wenn Zunder ablehnt, `503` bei `!` ohne Zunder.

### Suche

`GET <PUBLIC_URL>/api/search?q=…` mit Header `Authorization: Bearer <SEARCH_TOKEN>`
durchsucht den Vault für Clients ohne OAuth, nur lesend und nur in eigenen Notizen
ohne vertrauliche Ordner. Parameter: `q` (Pflicht), `mode` (`hybrid` Standard oder
`semantic`), `folder`, `limit` (Standard 10, höchstens 50), `offset`. Antwort:
`200 {"results":[{"path","title","streams","similarity","score",…}],"total","hasMore","degraded"}`,
Pfade relativ zum Vault mit `/`. `400` bei falscher Eingabe, `401` ohne gültigen Token.
`GET /capture` ist ein Verbindungstest.

Mail-Abruf: Nur Absender aus `MAIL_ALLOWED_SENDERS` werden verarbeitet, alle
anderen Mails wandern unverarbeitet in den Ablage-Ordner. Ein Eintrag mit
führendem `@` (z. B. `@rubeen.dev`) gibt jede Adresse dieser Domain frei, aber
keine Subdomain. Der Absender einer Mail lässt sich fälschen; die Adresse deshalb
nicht weitergeben. Mit ganzen Domains wird die Annahme breiter, also die
Alias-Adresse erst recht geheim halten. Den API-Token in
Fastmail unter *Einstellungen → Passwörter & Sicherheit → API-Tokens* mit
Zugriff nur auf Mail anlegen.

**Zunder-Brücke:** Eine offene Checkbox mit dem Tag `#zunder` wird eine Aufgabe
in der Zunder-Inbox. Die Aufgabe verweist auf die Notiz (`vault_links`, Wikilink
und optional „In Obsidian öffnen“), in der Notiz ersetzt ein Link auf die
Aufgabe den Tag:

```markdown
- [ ] Angebot schreiben #zunder
- [ ] Angebot schreiben [↗ Zunder](https://zunder.example/#/aufgabe/…)
```

Die Brücke prüft geänderte Notizen sofort und alle Notizen mit dem Tag beim Start
und im Reindex-Intervall. Vertrauliche Ordner, Readwise-Importe und Codeblöcke
bleiben außen vor.

Zurück geht es im selben Takt (Start und Reindex-Intervall): Ist die verlinkte
Aufgabe in Zunder erledigt, wird die Checkbox abgehakt (`- [x]`); ist sie
verworfen, wird sie als abgebrochen markiert (`- [-]`, wie im Tasks-Plugin).
Gezählt werden nur Links auf die eingestellte Zunder-Adresse.

Andersherum erledigt Abhaken im Vault die Aufgabe in Zunder (`- [x]` → erledigt,
`- [-]` → verworfen), ebenfalls spätestens nach einem Intervall. Die Brücke
merkt sich dafür je Notiz und Aufgabe die zuletzt gesehene Checkbox (im
Merkzettel unter `/data`) und meldet nur den Wechsel von offen zu geschlossen.
Wer eine Aufgabe in Zunder wieder öffnet, während die Checkbox noch abgehakt
ist, behält sie offen. Checkboxen, die die Brücke zum ersten Mal schon abgehakt
sieht (etwa nach dem Update), gelten nicht als Wechsel.

### Web-Cockpit

Unter `<PUBLIC_URL>/` liegt die Wochenansicht, gebaut um die Woche statt um
„Heute“. Oben das **Feuer-Ziel** aus der Feuer-Notiz der Woche (Frontmatter
`type: 1-wochen-feuer`, `zeitraum` ab Montag, Abschnitt „## Feuer-Ziel“) und die
**Flammen** der Woche aus Zunder, mit den dort gemessenen Zeiten. Darunter die
**Big Rocks** je Lebensbereich: Zunder-Aufgaben, die in der Woche fällig oder als
Phönix-Schritt der Woche markiert sind, gruppiert nach Zunder-Bereich. Es folgen
die **Termine** der Woche aus allen eingestellten Kalendern, **Aufgaben** in
Arbeit oder überfällig und die **Inbox** (Ordner im Vault und Zunder-Inbox). Mit
`?woche=2026-W43` blättert man; dieselben Daten gibt es als JSON unter `/api/woche`.

Einrichtung:

1. In Pocket ID einen OIDC-Client anlegen, Callback `<PUBLIC_URL>/auth/callback`,
   und wie beim CIMD-Client auf die eigene Gruppe beschränken.
2. Im Deployment `WEB_CLIENT_ID` und `WEB_CLIENT_SECRET` setzen (bei einem
   öffentlichen Client mit PKCE bleibt das Secret leer). Zugang haben dieselben
   `ALLOWED_SUBJECTS` wie bei MCP.
3. Anmelden und unter **Einstellungen** (`/einstellungen`) die Kalender eintragen.
   Beliebig viele, je als **iCal-Abo** (die geheime `.ics`-Adresse eines
   Kalenders, `webcal://` geht auch; Serientermine löst das Cockpit selbst auf)
   oder als **CalDAV** (Kalender-Home oder einzelner Kalender, mit Benutzer und
   App-Passwort; optional nur bestimmte Kalender). Daneben Zeitzone, Vault-Name
   für „In Obsidian öffnen“ und der Inbox-Ordner.

Der Zunder-Zugang kommt aus `ZUNDER_URL`/`ZUNDER_TOKEN` (Capture), lässt sich in
den Einstellungen aber durch einen eigenen ersetzen. Leere Felder gelten als
Standard aus der Umgebung (`COCKPIT_TZ`, `OBSIDIAN_VAULT_NAME`, `CAPTURE_FOLDER`).

Gespeichert wird in `/data/cockpit-settings.json` (nur für den Dienst lesbar).
Passwörter, Tokens und Kalenderadressen zeigt die Seite nie wieder an; ein leeres
Feld behält den gespeicherten Wert. Das Secret für das Sitzungs-Cookie liegt in
`/data/session-secret` und entsteht beim ersten Start (alternativ `SESSION_SECRET`).

Fällt eine Quelle aus (Zunder nicht erreichbar, ein Kalender antwortet nicht),
zeigt nur ihr Abschnitt bzw. nur dieser Kalender den Fehler; die Einstellungsseite
zeigt je Kalender, ob er erreichbar ist. Die Sitzung gilt 12 Stunden und nur für
das Web-Cockpit; `/mcp` nimmt weiter ausschließlich Bearer-Tokens.

### Semantische Suche und Graph

Das Cockpit bettet alle eigenen Notizen (ohne Readwise-Importe) abschnittsweise mit
**bge-m3** ein, einem mehrsprachigen Modell, das lokal in einem eigenen
Ollama-Container läuft (`ollama` in `docker-compose.example.yml`). Die Vektoren
liegen in `VECTOR_DB` neben dem Index; neu eingebettet wird nur, was sich geändert
hat. Der erste Lauf über den ganzen Vault dauert auf der CPU eine Weile, den Stand
zeigt `vault_stats` unter `semantic`. Bis dahin und wenn Ollama ausfällt, sucht
`vault_search` per Volltext weiter und sagt das im Feld `degraded`.

- **Hybride Suche** (`vault_search`, Standard): Volltext, Embeddings und
  Link-Nachbarschaft der besten Treffer, zusammengeführt per Reciprocal Rank
  Fusion. Findet auch Notizen, die dasselbe mit anderen Worten sagen. `mode: "text"`
  ist die bisherige UND-Volltextsuche, `mode: "semantic"` nur die Bedeutung.
- **Ähnliche Notizen** (`vault_similar`): Kandidaten für Querverbindungen, mit
  `unlinked_only` nur die noch nicht verlinkten.
- **Graph** (`vault_graph`, Seite `<PUBLIC_URL>/graph`): Wikilinks, semantische Kanten
  („ähnlich, aber nicht verlinkt“, gestrichelt), Zunder-Aufgaben aus Links in der
  Notiz (Status aus Zunder) und bei Tagesnotizen die Termine des Tages. Die Seite
  `/graph` ist zugleich die Suche des Web-Cockpits; ein Klick auf eine Notiz
  zentriert den Graphen neu. Als JSON unter `/api/graph?pfad=…`.

Einrichtung: Dienst `ollama` und `EMBED_URL` wie im Compose-Beispiel; das Modell
lädt das Cockpit beim ersten Lauf selbst. Vertrauliche Notizen werden mit
eingebettet (das Modell läuft lokal), aber wie beim Volltext nur auf ausdrückliche
Anforderung ausgeliefert.

`mycel.py` (vault-skills) bleibt für Lebenszyklus, Lint und Supersession des
Mycel-Wikis zuständig; einen zweiten Embedding-Index baut es nicht auf (siehe
[docs/roadmap.md](docs/roadmap.md)).

Tests, ohne laufenden Container:
```bash
npm ci && npm test
```

## Aufbau

- `src/oauth/` — Token-Prüfung (RFC 9068, Audience-Bindung), Principal-Cache
- `src/vault/` — Markdown-Parser, SQLite-FTS5-Index, Link-Graph, Policy, Capture, Bearbeiten
- `src/mcp/` — MCP-Werkzeuge auf Basis von `@modelcontextprotocol/server` v2
- `src/http/` — HTTP-Schicht, Protected Resource Metadata, Host-Prüfung
- `src/sync/` — Sync-Adapter: Dateibeobachtung, inkrementeller Reindex, Sync-Status
- `src/capture/` — Capture von außen: Endpunkte, Mail-Abruf, Zunder-Weiterleitung und -Brücke
- `src/cockpit/` — Wochenmodell: ISO-Wochen, Feuer-Notiz, Kalender (iCal mit Serienauflösung, CalDAV), Einstellungen, Zusammenstellung aus Zunder
- `src/semantic/` — Embeddings (Ollama), Abschnitte, Vektorspeicher, hybride Suche
- `src/search/` — lesender Such-Endpunkt `/api/search` mit eigenem Token
- `src/graph/` — Graph um eine Notiz mit Aufgaben- und Termin-Knoten
- `src/web/` — Web-Cockpit: OIDC-Login mit PKCE, signiertes Sitzungs-Cookie, HTML der Wochenansicht, Einstellungen, Suche und Graph
- `sync/` — Image des Sidecars `vault-sync` (Obsidian Headless mit Status-Wrapper)

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
- **Web-Login getrennt von MCP:** Das Web-Cockpit hat einen eigenen OIDC-Client
  und prüft das ID-Token (Signatur, `iss`, `aud` = Client-ID, `nonce`, PKCE,
  Subject). Das Sitzungs-Cookie ist `HttpOnly`, `Secure`, `SameSite=Lax` und gilt
  nicht für `/mcp`. Die Seiten laden kein JavaScript; die Content-Security-Policy
  erlaubt nur das eigene Stylesheet.
- **Readwise-Importe** sind eine eigene Indexklasse und standardmäßig aus der Suche
  ausgenommen, damit importierte Fremdtexte die eigenen Notizen nicht verdrängen.

Hintergrund und Entscheidungen: `docs/design.md`.
