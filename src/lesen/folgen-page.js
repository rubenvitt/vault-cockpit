import { openSync, readSync, closeSync, statSync } from 'node:fs';
import { esc } from '../web/layout.js';
import { hidden } from '../web/render.js';
import { ActionError } from '../cockpit/actions.js';
import { readingPage } from './pages.js';
import { WINDOWS, fitToWindow } from './stack.js';
import { EpisodeError, KINDS, LENGTHS } from './folgen.js';

/**
 * Seiten der Folgen (src/lesen/folgen.js), ohne JavaScript bedienbar:
 *
 * - `/lesen/folgen/neu?zeit=30`: Texte des Zeitfensters zum Abhaken, Art,
 *   Länge und die geschätzten Zeichen, die ElevenLabs berechnet.
 * - `/lesen/folgen`: alle Folgen mit Stand, Player, Link zur Report-Notiz.
 * - `/lesen/folgen/audio?id=…`: die MP3, mit `Range` (Safari spielt Audio
 *   nur so ab, und Vorspulen braucht es auch).
 */

const fmt = new Intl.NumberFormat('de-DE');
const DESCRIPTIONS = {
  vorlesen: 'Die ganzen Texte nacheinander, eine Erzählerstimme.',
  podcast: 'Claude schreibt ein Gespräch zweier Stimmen über die Texte.',
  report: 'Claude schreibt einen Bericht: als Notiz in die Inbox und eine Stimme liest ihn.',
};

function when(iso, tz) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function state(ep) {
  if (ep.status === 'spricht' && ep.total) return `wird gesprochen (${ep.done ?? 0} von ${ep.total})`;
  return { wartet: 'wartet', schreibt: 'Claude schreibt', fertig: 'fertig', fehler: 'Fehler' }[ep.status] ?? ep.status;
}

function newPage(episodes, store, ctx) {
  const n = Number(ctx.url.searchParams.get('zeit'));
  const zeit = WINDOWS.includes(n) ? n : 30;
  const { items } = fitToWindow(store.list({ status: 'stapel', limit: -1 }), zeit);
  const missing = episodes.availability();
  const picker = `<nav class="chips stapel-zeit" aria-label="Zeitfenster">${WINDOWS.map((m) => `<a href="/lesen/folgen/neu?zeit=${m}" class="chip"${m === zeit ? ' aria-current="true"' : ''}>${m} Min.</a>`).join('')}</nav>`;
  if (!items.length) return `${picker}<p class="empty">Für dieses Zeitfenster passt nichts vom Stapel.</p>`;
  let full = 0;
  try {
    full = episodes.preview({ kind: 'vorlesen', docIds: items.map((d) => d.id) }).chars;
  } catch {
    /* keine Texte mit Text: Vorlesen geht dann ohnehin nicht */
  }
  const docs = items
    .map((d) => `<li class="lesen-item"><label class="checkline"><input type="checkbox" name="doc" value="${esc(d.id)}" checked> <span class="lesen-title">${esc(d.title || d.url)}</span></label><span class="meta">${esc([`${d.reading_minutes} Min.`, d.site].filter(Boolean).join(' · '))}</span></li>`)
    .join('');
  const first = Object.keys(KINDS).find((k) => !missing[k]);
  const kinds = Object.entries(KINDS)
    .map(([kind, label]) => {
      const cost = kind === 'vorlesen' ? `rund ${fmt.format(full)} Zeichen bei ElevenLabs` : `rund 900 Zeichen je Minute bei ElevenLabs, dazu dein Claude-Abo`;
      const off = missing[kind];
      return `<label class="checkline"><input type="radio" name="art" value="${kind}"${off ? ' disabled' : kind === first ? ' checked' : ''}> <b>${label}</b>: ${esc(DESCRIPTIONS[kind])} <span class="meta">${esc(off ?? cost)}</span></label>`;
    })
    .join('');
  return `${picker}
  <form method="post" action="/aktion/lesen/folge/neu" class="folge-neu">
    ${hidden({ csrf: ctx.write.csrf, back: ctx.write.back })}
    <fieldset><legend>Texte</legend><ul class="lesen-list">${docs}</ul></fieldset>
    <fieldset><legend>Art</legend>${kinds}</fieldset>
    <label class="field"><span>Länge bei Podcast und Report</span><select name="laenge">${LENGTHS.map((m) => `<option value="${m}"${m === 10 ? ' selected' : ''}>${m} Minuten</option>`).join('')}</select></label>
    <p class="meta">Die Folge entsteht im Hintergrund und steht dann unter <a href="/lesen/folgen">Folgen</a>. Das Vorlesen ganzer Texte kostet so viele Zeichen, wie die Texte lang sind.</p>
    <p><button type="submit" class="btn primary">Folge erzeugen</button></p>
  </form>`;
}

function listPage(episodes, ctx) {
  const list = episodes.list();
  const head = '<p class="stapel-hoeren"><a href="/lesen/folgen/neu" class="btn primary">Neue Folge</a></p>';
  if (!list.length) return `${head}<p class="empty">Noch keine Folgen. Aus dem Stapel lassen sich Texte vorlesen, als Podcast besprechen oder zu einem Report zusammenfassen.</p>`;
  const busy = list.some((e) => ['wartet', 'schreibt', 'spricht'].includes(e.status));
  const items = list
    .map((ep) => {
      const meta = [KINDS[ep.kind], ep.minutes ? `${ep.minutes} Min.` : null, `${fmt.format(ep.chars ?? 0)} Zeichen`, when(ep.created_at, ctx.tz), state(ep)].filter(Boolean).join(' · ');
      const player = ep.status === 'fertig' ? `<audio controls preload="none" src="/lesen/folgen/audio?id=${encodeURIComponent(ep.id)}"></audio>` : '';
      const note = ep.note ? `<a href="/notiz?pfad=${encodeURIComponent(ep.note)}" class="btn quiet">Report-Notiz</a>` : '';
      const error = ep.status === 'fehler' ? `<p class="problem">${esc(ep.error ?? 'Unbekannter Fehler')}</p>` : '';
      const remove =
        ep.status === 'schreibt' || ep.status === 'spricht'
          ? ''
          : `<form method="post" action="/aktion/lesen/folge/loeschen" class="inline">${hidden({ csrf: ctx.write.csrf, back: ctx.write.back, id: ep.id })}<button type="submit" class="btn quiet">Löschen</button></form>`;
      return `<li class="lesen-item folge" data-folge="${esc(ep.id)}">
    <span class="lesen-title">${esc(ep.title)}</span>
    <span class="meta">${esc(meta)}</span>
    ${error}${player}
    <span class="folge-actions">${note}${remove}</span>
  </li>`;
    })
    .join('');
  return `${head}${busy ? '<p class="meta">Eine Folge entsteht gerade. Seite neu laden zeigt den Stand.</p>' : ''}<ul class="lesen-list folgen">${items}</ul>`;
}

/** `bytes=a-b` → `[start, end]` (einschließlich) in `size`, `null` = ganze Datei, `false` = nicht erfüllbar. */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? [start, end] : false;
}

function readPart(path, start, end) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(end - start + 1);
    readSync(fd, buf, 0, buf.length, start);
    return buf;
  } finally {
    closeSync(fd);
  }
}

const asAction = (run) => {
  try {
    return run();
  } catch (err) {
    if (err instanceof EpisodeError) throw new ActionError(err.message, err.status);
    throw err;
  }
};

export function folgenRoutes({ store, episodes }) {
  if (!episodes) return { pages: {}, actions: {} };
  return {
    pages: {
      async '/lesen/folgen'(ctx) {
        return { html: readingPage(ctx, { key: 'folgen', title: 'Folgen', body: `<section>${listPage(episodes, ctx)}</section>` }) };
      },
      async '/lesen/folgen/neu'(ctx) {
        return { html: readingPage(ctx, { key: 'folgen', title: 'Neue Folge', body: `<section>${newPage(episodes, store, ctx)}</section>` }) };
      },
      async '/lesen/folgen/audio'(ctx) {
        const path = episodes.audioPath(ctx.url.searchParams.get('id') ?? '');
        if (!path) return { status: 404, body: 'Diese Folge gibt es nicht (oder sie ist noch nicht fertig).', headers: { 'content-type': 'text/plain; charset=utf-8' } };
        const size = statSync(path).size;
        const base = { 'content-type': 'audio/mpeg', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=86400' };
        const range = parseRange(ctx.range, size);
        if (range === false) return { status: 416, body: '', headers: { ...base, 'content-range': `bytes */${size}` } };
        const [start, end] = range ?? [0, size - 1];
        const body = size ? readPart(path, start, end) : Buffer.alloc(0);
        return { status: range ? 206 : 200, body, headers: { ...base, 'content-length': String(body.length), ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) } };
      },
    },
    actions: {
      async '/aktion/lesen/folge/neu'(form) {
        const ep = asAction(() => episodes.create({ kind: form.get('art') ?? '', docIds: form.getAll('doc'), minutes: Number(form.get('laenge') ?? 10) }));
        ep.done?.catch(() => {});
        return { message: `${KINDS[ep.kind]} entsteht im Hintergrund, rund ${fmt.format(ep.chars)} Zeichen.`, redirect: '/lesen/folgen' };
      },
      async '/aktion/lesen/folge/loeschen'(form) {
        const ep = asAction(() => episodes.remove(form.get('id') ?? ''));
        return { message: `Gelöscht: ${ep.title}`, redirect: '/lesen/folgen' };
      },
    },
  };
}
