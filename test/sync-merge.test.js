import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, mergeLines, mergeFile, conflictName } from '../src/sync/server/merge.js';

const L = (s) => s.split(/(?<=\n)/).filter(Boolean);
const merge = (path, o, a, b) => mergeFile(path, Buffer.from(o), Buffer.from(a), Buffer.from(b))?.toString('utf8') ?? null;

test('diffLines findet die geänderten Abschnitte', () => {
  assert.deepEqual(diffLines(L('a\nb\nc\n'), L('a\nb\nc\n')), []);
  assert.deepEqual(diffLines(L('a\nb\nc\n'), L('a\nX\nc\n')), [{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
  assert.deepEqual(diffLines([], L('a\n')), [{ aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 }]);
  assert.deepEqual(diffLines(L('a\nb\n'), []), [{ aStart: 0, aEnd: 2, bStart: 0, bEnd: 0 }]);
  // Einfügen und Löschen an verschiedenen Stellen.
  const h = diffLines(L('1\n2\n3\n4\n5\n'), L('0\n1\n2\n4\n5\n6\n'));
  assert.deepEqual(h, [
    { aStart: 0, aEnd: 0, bStart: 0, bEnd: 1 },
    { aStart: 2, aEnd: 3, bStart: 3, bEnd: 3 },
    { aStart: 5, aEnd: 5, bStart: 5, bEnd: 6 },
  ]);
  assert.equal(diffLines(L('a\n'.repeat(10)), L('b\n'.repeat(10)), 5), null, 'zu viele Änderungen');
});

test('diffLines setzt jede Fassung korrekt zusammen (Zufall)', () => {
  let seed = 7;
  const rnd = (n) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
  for (let round = 0; round < 200; round += 1) {
    const a = Array.from({ length: rnd(15) }, () => `${rnd(4)}\n`);
    const b = Array.from({ length: rnd(15) }, () => `${rnd(4)}\n`);
    const out = [];
    let pos = 0;
    for (const h of diffLines(a, b)) {
      out.push(...a.slice(pos, h.aStart), ...b.slice(h.bStart, h.bEnd));
      pos = h.aEnd;
    }
    out.push(...a.slice(pos));
    assert.deepEqual(out, b);
  }
});

test('getrennte Absätze auf zwei Geräten geändert: beide Änderungen im Ergebnis', () => {
  const base = '# Notiz\n\nErster Absatz.\n\nZweiter Absatz.\n\nDritter Absatz.\n';
  const mac = '# Notiz\n\nErster Absatz, am Mac ergänzt.\n\nZweiter Absatz.\n\nDritter Absatz.\n';
  const phone = '# Notiz\n\nErster Absatz.\n\nZweiter Absatz.\n\nDritter Absatz vom iPhone.\n\nNeuer Schluss.\n';
  assert.equal(
    merge('a.md', base, mac, phone),
    '# Notiz\n\nErster Absatz, am Mac ergänzt.\n\nZweiter Absatz.\n\nDritter Absatz vom iPhone.\n\nNeuer Schluss.\n',
  );
});

test('überlappende oder aneinanderstoßende Änderungen sind ein Konflikt, gleiche nicht', () => {
  assert.equal(merge('a.md', 'a\nb\nc\n', 'a\nX\nc\n', 'a\nY\nc\n'), null);
  assert.equal(merge('a.md', 'a\nb\nc\n', 'a\nX\nc\n', 'a\nb\nY\n'), null, 'Nachbarzeilen');
  assert.equal(merge('a.md', 'a\n', 'a\nX\n', 'a\nY\n'), null, 'beide hängen an');
  assert.equal(merge('a.md', 'a\nb\n', 'a\nX\n', 'a\nX\n'), 'a\nX\n');
  assert.deepEqual(mergeLines(L('a\n'), L('a\n'), L('a\nb\n')), L('a\nb\n'));
});

test('Frontmatter wird feldweise zusammengeführt', () => {
  const base = '---\ntitle: Alt\ntags:\n  - a\nstatus: offen\n---\nText\n';
  const mac = '---\ntitle: Neu\ntags:\n  - a\nstatus: offen\n---\nText\n';
  const phone = '---\ntitle: Alt\ntags:\n  - a\nstatus: offen\n---\nText\n';
  const phone2 = '---\ntitle: Alt\ntags:\n  - a\n  - b\nstatus: offen\n---\nText\n';
  assert.equal(merge('n.md', base, mac, phone2), '---\ntitle: Neu\ntags:\n  - a\n  - b\nstatus: offen\n---\nText\n');
  assert.equal(merge('n.md', base, mac, phone), mac);
  // Ein Feld hinzu, eins gelöscht.
  const added = '---\ntitle: Alt\ntags:\n  - a\nstatus: offen\ndue: 2026-11-01\n---\nText\n';
  const removed = '---\ntitle: Alt\ntags:\n  - a\n---\nText\n';
  assert.equal(merge('n.md', base, added, removed), '---\ntitle: Alt\ntags:\n  - a\ndue: 2026-11-01\n---\nText\n');
  // Dasselbe Feld verschieden geändert: Konflikt, auch wenn der Text darunter passt.
  const other = '---\ntitle: Anders\ntags:\n  - a\nstatus: offen\n---\nText\n';
  assert.equal(merge('n.md', base, mac, other), null);
  // Neues Frontmatter auf einer Seite.
  assert.equal(merge('n.md', 'Text\n', '---\ntitle: X\n---\nText\n', 'Text\nmehr\n'), '---\ntitle: X\n---\nText\nmehr\n');
});

test('Binärdateien, Canvas und kaputtes UTF-8 werden nicht gemergt', () => {
  assert.equal(merge('bild.png', 'a\n', 'a\nb\n', 'c\na\n'), null);
  assert.equal(merge('karte.canvas', 'a\n', 'a\nb\n', 'c\na\n'), null);
  assert.equal(mergeFile('a.md', Buffer.from('a\n'), Buffer.from([0xff, 0x0a]), Buffer.from('a\n')), null);
  assert.equal(merge('a.txt', 'a\nb\nc\n', 'X\nb\nc\n', 'a\nb\nY\n'), 'X\nb\nY\n');
  assert.equal(merge('a.md', 'a\r\nb\r\nc\r\n', 'X\r\nb\r\nc\r\n', 'a\r\nb\r\nY\r\n'), 'X\r\nb\r\nY\r\n', 'CRLF bleibt');
});

test('Name der Konfliktkopie', () => {
  assert.equal(conflictName('Ordner/Notiz.md', 'iPhone', '2026-10-29'), 'Ordner/Notiz (Konflikt iPhone 2026-10-29).md');
  assert.equal(conflictName('Notiz.md', 'iPhone', '2026-10-29', 2), 'Notiz (Konflikt iPhone 2026-10-29 2).md');
  assert.equal(conflictName('a/b/LIESMICH', '../böse/Gerät', '2026-10-29'), 'a/b/LIESMICH (Konflikt -böse-Gerät 2026-10-29)');
  assert.equal(conflictName('x.tar.gz', '', '2026-10-29'), 'x.tar (Konflikt Gerät 2026-10-29).gz');
});
