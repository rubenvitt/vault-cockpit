import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSettingsStore } from '../cockpit/settings.js';
import { localDate, weekId, weekOf } from '../cockpit/week.js';
import { clusterReport } from '../lesen/cluster-measure.js';
import { CLUSTER_THRESHOLD } from '../lesen/review-page.js';
import { createOllamaEmbedder } from '../semantic/embedder.js';

/**
 * Bericht zur Cluster-Schwelle im Wiedersehen (VCP-129): bettet alle
 * Markierungen des Lesestapels mit dem Embedding-Server aus den Einstellungen
 * ein (wie das Cockpit, `EMBED_URL`/`EMBED_MODEL` als Rückfall) und schreibt
 * Markdown nach stdout, Fortschritt nach stderr. Liest die Datenbank nur,
 * läuft also auch neben dem Cockpit:
 *
 *   docker compose exec cockpit npm run -s messen:cluster > cluster.md
 *
 * Der Bericht enthält Zitate aus den Markierungen.
 */

const settingsFile = process.env.COCKPIT_SETTINGS_FILE ?? '/data/cockpit-settings.json';
const dbPath = process.env.LESESTAPEL_DB ?? join(dirname(settingsFile), 'lesestapel.db');
const BATCH = 32;

const log = (msg) => process.stderr.write(`${msg}\n`);
const quiet = { info() {}, warn: log, error: log };

const settings = createSettingsStore({
  file: settingsFile,
  defaults: { tz: process.env.COCKPIT_TZ || 'Europe/Berlin', embedUrl: process.env.EMBED_URL || null, embedModel: process.env.EMBED_MODEL || 'bge-m3' },
  logger: quiet,
}).get();

if (!existsSync(dbPath)) {
  log(`Kein Lesestapel unter ${dbPath} (LESESTAPEL_DB setzen).`);
  process.exit(1);
}
if (!settings.embed) {
  log('Kein Embedding-Server: Einstellungen → Embeddings oder EMBED_URL setzen.');
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const items = db
  .prepare(
    `SELECT h.id, h.doc_id, h.quote, h.created_at, d.title AS doc_title, d.url AS doc_url
     FROM highlights h JOIN documents d ON d.id = h.doc_id
     ORDER BY h.created_at DESC, h.rowid DESC`,
  )
  .all();
db.close();

if (items.length < 2) {
  log(`Erst ${items.length} Markierung(en), zu wenig zum Messen.`);
  process.exit(1);
}

const embedder = createOllamaEmbedder({ url: settings.embed.url, model: settings.embed.model, logger: quiet });
log(`${items.length} Markierungen, bette ein mit ${embedder.model} über ${settings.embed.url} …`);
const vectors = [];
for (let i = 0; i < items.length; i += BATCH) {
  vectors.push(...(await embedder.embed(items.slice(i, i + BATCH).map((h) => h.quote))));
  process.stderr.write(`\r  ${vectors.length}/${items.length}`);
}
process.stderr.write('\n');

const { tz } = settings;
process.stdout.write(
  clusterReport({
    items,
    vectors,
    model: embedder.model,
    current: CLUSTER_THRESHOLD,
    date: localDate(new Date(), tz),
    groupOf: (h) => weekId(weekOf(new Date(h.created_at), tz)),
  }),
);
