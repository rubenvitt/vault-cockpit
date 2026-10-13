import { buildIndex, openIndex } from '../vault/index.js';
import { loadPolicy } from '../vault/policy.js';

const vaultPath = process.env.VAULT_PATH ?? '/vault';
const dbPath = process.env.INDEX_DB ?? '/data/index.db';

const started = Date.now();
console.log(`Indexiere ${vaultPath} → ${dbPath}`);

const { db, count } = buildIndex({
  vaultPath,
  dbPath,
  policy: loadPolicy(process.env.POLICY_FILE),
  onProgress: (n) => process.stdout.write(`\r  ${n} Notizen …`),
});
process.stdout.write('\r');

const idx = openIndex(db);
const s = idx.stats();
console.log(`Fertig in ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`  Notizen gesamt : ${s.total}`);
console.log(`  davon core     : ${s.byClass.core ?? 0}`);
console.log(`  davon readwise : ${s.byClass.readwise ?? 0}`);
console.log(`  Tags distinkt  : ${s.distinctTags}`);
console.log(`  Links          : ${s.resolvedLinks}/${s.links} aufgelöst`);
idx.close();
