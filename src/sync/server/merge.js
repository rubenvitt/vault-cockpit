/**
 * 3-Wege-Merge für den eigenen Sync (VCP-122): Schickt ein Gerät eine Datei
 * auf veralteter Basis, führt der Server die Fassung des Geräts mit seiner
 * eigenen zusammen, wenn sich die Änderungen nicht berühren. Die gemeinsame
 * Basis kommt aus dem Blob-Speicher des Journals.
 *
 * - Text (Markdown, .txt): zeilenweise wie diff3. Änderungen, die sich
 *   überlappen oder direkt aneinanderstoßen, gelten als Konflikt.
 * - Frontmatter: feldweise; dasselbe Feld auf beiden Seiten verschieden
 *   geändert ist ein Konflikt.
 * - Alles andere (Binärdateien, Canvas-JSON) wird nicht gemergt.
 *
 * Bei einem Konflikt kommt `null` zurück; dann legt das Journal die Fassung
 * des Geräts als Konfliktkopie ab.
 */

const MERGEABLE = /\.(md|markdown|txt)$/i;
/** Mehr Änderungen als das lohnt keinen Merge mehr (und hält den Speicher klein). */
const MAX_EDITS = 4000;

const decoder = new TextDecoder('utf-8', { fatal: true });
const decode = (buf) => {
  try {
    return decoder.decode(buf);
  } catch {
    return null;
  }
};

/** Zeilen samt Zeilenende, damit das Zusammensetzen die Datei Byte für Byte erhält. */
const lines = (text) => (text ? text.split(/(?<=\n)/) : []);

/**
 * Unterschiede zweier Zeilenlisten (Myers) als Abschnitte
 * `{aStart, aEnd, bStart, bEnd}`: a[aStart, aEnd) wurde zu b[bStart, bEnd).
 * `null`, wenn es mehr als `maxEdits` Änderungen sind.
 */
export function diffLines(a, b, maxEdits = MAX_EDITS) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post += 1;
  const A = a.slice(pre, a.length - post);
  const B = b.slice(pre, b.length - post);
  const n = A.length;
  const m = B.length;

  // Myers: trace[d] hält die weitesten x je Diagonale k ∈ [-d, d] nach Schritt d.
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = n === 0 && m === 0 ? 0 : -1;
  if (found < 0) {
    for (let d = 0; d <= max && found < 0; d += 1) {
      if (d > maxEdits) return null;
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) {
          x += 1;
          y += 1;
        }
        v[off + k] = x;
        if (x >= n && y >= m) {
          found = d;
          break;
        }
      }
      trace.push(v.slice(off - d, off + d + 1));
    }
  }

  // Rückwärts die gemeinsamen Zeilen einsammeln.
  const matches = [];
  if (found > 0) {
    const at = (d, k) => trace[d][k + d];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d -= 1) {
      const k = x - y;
      const down = k === -d || (k !== d && at(d - 1, k - 1) < at(d - 1, k + 1));
      const prevK = down ? k + 1 : k - 1;
      const prevX = at(d - 1, prevK);
      const prevY = prevX - prevK;
      const startX = down ? prevX : prevX + 1;
      const startY = down ? prevY + 1 : prevY;
      while (x > startX && y > startY) {
        x -= 1;
        y -= 1;
        matches.push([x, y]);
      }
      x = prevX;
      y = prevY;
    }
    while (x > 0 && y > 0) {
      x -= 1;
      y -= 1;
      matches.push([x, y]);
    }
    matches.reverse();
  } else {
    for (let i = 0; i < n; i += 1) matches.push([i, i]);
  }

  const hunks = [];
  let ai = 0;
  let bi = 0;
  for (const [i, j] of [...matches, [n, m]]) {
    if (i > ai || j > bi) hunks.push({ aStart: pre + ai, aEnd: pre + i, bStart: pre + bi, bEnd: pre + j });
    ai = i + 1;
    bi = j + 1;
  }
  return hunks;
}

/**
 * Zeilenweiser 3-Wege-Merge. Liefert die zusammengeführten Zeilen oder
 * `null` bei einem Konflikt.
 */
export function mergeLines(base, ours, theirs) {
  const side = (other, name) => {
    const hunks = diffLines(base, other);
    return hunks && hunks.map((h) => ({ side: name, start: h.aStart, end: h.aEnd, lines: other.slice(h.bStart, h.bEnd) }));
  };
  const a = side(ours, 'a');
  const b = side(theirs, 'b');
  if (!a || !b) return null;
  const all = [...a, ...b].sort((x, y) => x.start - y.start || x.end - y.end);

  // Abschnitte, die sich überlappen oder berühren, gehören zu einer Gruppe.
  const groups = [];
  for (const h of all) {
    const g = groups.at(-1);
    if (g && h.start <= g.end) {
      g.hunks.push(h);
      g.end = Math.max(g.end, h.end);
    } else {
      groups.push({ start: h.start, end: h.end, hunks: [h] });
    }
  }

  // Wie eine Seite den Bereich base[start, end) sieht.
  const view = (hunks, start, end) => {
    const out = [];
    let pos = start;
    for (const h of hunks) {
      out.push(...base.slice(pos, h.start), ...h.lines);
      pos = h.end;
    }
    out.push(...base.slice(pos, end));
    return out;
  };

  const out = [];
  let pos = 0;
  for (const g of groups) {
    out.push(...base.slice(pos, g.start));
    const fromA = g.hunks.filter((h) => h.side === 'a');
    const fromB = g.hunks.filter((h) => h.side === 'b');
    if (!fromB.length) out.push(...view(fromA, g.start, g.end));
    else if (!fromA.length) out.push(...view(fromB, g.start, g.end));
    else {
      const va = view(fromA, g.start, g.end);
      const vb = view(fromB, g.start, g.end);
      // Beide Seiten haben dasselbe geändert: kein Konflikt.
      if (va.length !== vb.length || va.some((l, i) => l !== vb[i])) return null;
      out.push(...va);
    }
    pos = g.end;
  }
  out.push(...base.slice(pos));
  return out;
}

/** Frontmatter am Anfang (`---` … `---`) abtrennen; `fields` ist null ohne Frontmatter. */
function splitFrontmatter(text) {
  const m = /^---\r?\n/.exec(text);
  if (!m) return { fields: null, body: text };
  const rest = lines(text.slice(m[0].length));
  const close = rest.findIndex((l) => /^(---|\.\.\.)\r?\n?$/.test(l));
  if (close < 0) return { fields: null, body: text };
  // Ein Feld ist eine Zeile `schlüssel:` am Zeilenanfang samt allen eingerückten
  // Folgezeilen (Listen, mehrzeilige Werte). Was vor dem ersten Feld steht, zählt als Feld „“.
  const fields = new Map();
  let key = '';
  for (const l of rest.slice(0, close)) {
    const k = /^([^\s#\-][^:]*):(\s|$)/.exec(l);
    if (k) key = k[1];
    fields.set(key, (fields.get(key) ?? '') + l);
  }
  return { fields, open: m[0], close: rest[close], body: rest.slice(close + 1).join('') };
}

/** Feldweiser 3-Wege-Merge des Frontmatters; `null` bei einem Konflikt. */
function mergeFields(base, ours, theirs) {
  const out = new Map();
  const keys = [...ours.keys(), ...[...theirs.keys()].filter((k) => !ours.has(k)), ...base.keys()];
  for (const k of new Set(keys)) {
    const o = base.get(k);
    const x = ours.get(k);
    const y = theirs.get(k);
    let v;
    if (x === y) v = x;
    else if (x === o) v = y;
    else if (y === o) v = x;
    else return null;
    if (v !== undefined) out.set(k, v);
  }
  return out;
}

/**
 * Führt drei Fassungen einer Datei zusammen (Buffer). Liefert den Inhalt als
 * Buffer oder `null`, wenn die Datei nicht mergebar ist oder sich die
 * Änderungen widersprechen.
 */
export function mergeFile(path, base, ours, theirs) {
  if (!MERGEABLE.test(path)) return null;
  const [o, a, b] = [base, ours, theirs].map(decode);
  if (o === null || a === null || b === null) return null;

  const fo = splitFrontmatter(o);
  const fa = splitFrontmatter(a);
  const fb = splitFrontmatter(b);
  let head = '';
  if (fa.fields || fb.fields) {
    const fields = mergeFields(fo.fields ?? new Map(), fa.fields ?? new Map(), fb.fields ?? new Map());
    if (!fields) return null;
    const shape = fa.fields ? fa : fb;
    if (fields.size) head = shape.open + [...fields.values()].join('') + shape.close;
  }
  const body = mergeLines(lines(fo.body), lines(fa.body), lines(fb.body));
  if (!body) return null;
  return Buffer.from(head + body.join(''), 'utf8');
}

/**
 * Name der Konfliktkopie neben der Datei:
 * `Ordner/Notiz (Konflikt iPhone 2026-10-29).md`, ab der zweiten mit Zähler.
 */
export function conflictName(path, device, date, n = 1) {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  const who =
    String(device ?? '')
      .replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '-')
      .replace(/^[.\s]+/, '')
      .trim()
      .slice(0, 40) || 'Gerät';
  return `${dir}${stem} (Konflikt ${who} ${date}${n > 1 ? ` ${n}` : ''})${ext}`;
}
