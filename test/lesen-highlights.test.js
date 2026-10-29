import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadingStore } from '../src/lesen/store.js';
import { highlightRoutes, noteTitle } from '../src/lesen/highlights.js';

const quiet = { info() {}, warn() {}, error() {} };

function setup() {
  const store = createReadingStore({ path: ':memory:', now: () => Date.parse('2026-10-20T08:00:00Z') });
  const { doc } = store.addDocument({ url: 'https://blatt.test/a', title: 'Vom Lesen: Über [Stapel] #1' });
  const captured = [];
  const capture = async (input) => (captured.push(input), { kind: 'note', path: 'inbox/x.md', duplicate: false });
  const routes = highlightRoutes({ store, asAction: (fn) => fn(), capture, logger: quiet });
  const act = (path, fields) => routes.actions[path](new URLSearchParams(fields), { sub: 'ruben' });
  return { store, doc, act, captured };
}

test('Markierung entfernt (VCP-85): Rückgängig stellt auch den Stand im Wiedersehen wieder her', async () => {
  const { store, doc, act } = setup();
  const h = store.addHighlight({ doc_id: doc.id, quote: 'Satz', note: 'n' });
  store.updateHighlight(h.id, { review_box: 3, review_due: '2026-11-10T08:00:00.000Z', review_state: 'losgelassen' });

  const del = await act('/aktion/lesen/markierung/loeschen', { id: h.id });
  assert.equal(store.getHighlight(h.id), null);
  assert.deepEqual([del.undo.fields.box, del.undo.fields.faellig, del.undo.fields.zustand], [3, '2026-11-10T08:00:00.000Z', 'losgelassen']);

  await act(del.undo.action, del.undo.fields);
  const back = store.getHighlight(h.id);
  assert.deepEqual([back.review_box, back.review_due, back.review_state, back.note], [3, '2026-11-10T08:00:00.000Z', 'losgelassen', 'n']);

  // Ohne Stand wie bisher (Box 1, morgen fällig); halbe oder falsche Angaben lehnt es ab.
  const fresh = await act('/aktion/lesen/markierung/neu', { id: doc.id, quote: 'Neu' });
  assert.equal(store.getHighlight(fresh.highlight.id).review_box, 0);
  await assert.rejects(act('/aktion/lesen/markierung/neu', { id: doc.id, quote: 'X', box: '9', faellig: '', zustand: 'aktiv' }), /Ungültiger Stand/);
  await assert.rejects(act('/aktion/lesen/markierung/neu', { id: doc.id, quote: 'X', zustand: 'aktiv' }), /Ungültiger Stand/);
});

test('In Inbox (VCP-85): die Notiz heißt nach dem Text, ohne Zeichen, die Dateinamen oder Frontmatter stören', async () => {
  const { store, doc, act, captured } = setup();
  const h = store.addHighlight({ doc_id: doc.id, quote: 'Satz' });
  await act('/aktion/lesen/markierung/inbox', { markierung: h.id });
  assert.equal(captured[0].title, 'Zitat aus Vom Lesen Über Stapel 1');
  assert.equal(noteTitle('Zitat aus', { url: 'https://blog.example.com/x' }), 'Zitat aus blog.example.com');
  assert.equal(noteTitle('Zitat aus', { url: 'mail:1', title: ':::' }), 'Zitat aus einem Text');
});
