import { createCapture } from '../vault/capture.js';
import { createCaptureRouter, CaptureError, CAPTURE_ID } from '../capture/router.js';
import { articleUrl } from '../capture/syntax.js';
import { localDate, addDays, parseWeekId } from './week.js';

/** Status, die das Cockpit setzen darf: abhaken, zurücknehmen, anfangen, parken, verwerfen. */
export const SETTABLE = ['open', 'in_progress', 'blocked', 'done', 'dropped'];

/** Ziel für „Zuordnen“: `area:<id>`, `project:<id>`, `loose` oder `inbox`. */
const TARGET = /^(?:(area|project):([A-Za-z0-9_-]{1,64})|(loose|inbox))$/;

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Kurzwahl für die Fälligkeit; alles andere muss ein Datum JJJJ-MM-TT sein. */
export const DUE_PRESETS = ['heute', 'morgen', 'naechste-woche', 'keine'];

/**
 * Fälligkeit aus dem Formular → Datum JJJJ-MM-TT oder null (keine).
 * „nächste Woche“ ist der Montag der Folgewoche. Ungültig → undefined.
 */
export function resolveDue(value, today) {
  const v = String(value ?? '').trim();
  if (v === '' || v === 'keine') return null;
  if (v === 'heute') return today;
  if (v === 'morgen') return addDays(today, 1);
  if (v === 'naechste-woche') {
    const [y, m, d] = today.split('-').map(Number);
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mo = 0
    return addDays(today, 7 - dow);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toISOString().slice(0, 10) === v ? v : undefined;
}

export class ActionError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * Schreibende Aktionen des Web-Cockpits. Aufgaben ändert Zunder, das Cockpit
 * speichert keine eigenen. Notizen entstehen über dieselbe Capture-Logik wie
 * `/capture`: `!` vorne → Zunder-Inbox, sonst eine neue Notiz im Inbox-Ordner
 * aus den Einstellungen. `> https://…` ist mit `saveArticle` ein Artikel für
 * den Lesestapel (`({ url, clientId }) → { doc, duplicate }`, src/lesen/save.js).
 *
 * Zunder-Zugang und Inbox-Ordner werden bei jedem Aufruf frisch gelesen, damit
 * eine Änderung unter `/einstellungen` sofort gilt.
 */
export function createCockpitActions({ vaultPath, settings, policy, state, zunder, index = null, saveArticle = null, onFlame = null, now = () => new Date(), logger = console }) {
  const zunderOrFail = () => {
    const z = zunder();
    if (!z) throw new ActionError('Zunder ist nicht eingerichtet (Einstellungen → Zunder)', 503);
    return z;
  };
  const checkId = (id) => {
    if (!TASK_ID.test(String(id ?? ''))) throw new ActionError('Unbekannte Aufgabe');
  };
  /** Zunder-Aufruf; Fehler dort werden 502, eine leere Antwort auch. */
  const call = async (fn) => {
    let task;
    try {
      task = await fn(zunderOrFail());
    } catch (err) {
      if (err instanceof ActionError) throw err;
      throw new ActionError(err.message, 502);
    }
    if (!task) throw new ActionError('Zunder hat die Aufgabe nicht zurückgegeben', 502);
    return task;
  };
  let synthesisQueue = Promise.resolve();
  const summary = (task) => ({
    id: task.id,
    ref: task.ref ?? null,
    title: task.title,
    status: task.status,
    due: task.due ?? null,
    phoenix: task.phoenix ?? null,
    location: task.location ?? null,
  });

  const actions = {
    /** Setzt den Status einer Zunder-Aufgabe und liefert `{ id, ref, title, status }`. */
    async setStatus(id, status) {
      checkId(id);
      if (!SETTABLE.includes(status)) throw new ActionError(`Status „${status}“ ist hier nicht vorgesehen`);
      return summary(await call((z) => z.setStatus(id, status)));
    },

    /**
     * Verschiebt die Fälligkeit: Datum JJJJ-MM-TT, `heute`, `morgen`,
     * `naechste-woche` (Montag) oder `keine`. „Heute“ gilt in der Zeitzone
     * aus den Einstellungen, zum Zeitpunkt des Klicks.
     */
    async setDue(id, value) {
      checkId(id);
      const due = resolveDue(value, localDate(now(), settings.get().tz));
      if (due === undefined) throw new ActionError(`„${value}“ ist kein Datum`);
      return summary(await call((z) => z.updateTask(id, { due })));
    },

    /** Legt eine Aufgabe an eine andere Stelle (aus der Inbox in einen Bereich oder ein Projekt). */
    async move(id, target) {
      checkId(id);
      const m = TARGET.exec(String(target ?? ''));
      if (!m) throw new ActionError('Bitte einen Bereich oder ein Projekt wählen');
      const location = m[3] ? { kind: m[3] } : { kind: m[1], id: m[2] };
      return summary(await call((z) => z.moveTask(id, location)));
    },

    /**
     * Startet (`on`) oder stoppt eine Flamme. Liefert die Aufgabe mit
     * Start/Ende und ob Timing mitgemessen hat (`timing`: true, false oder
     * eine Fehlermeldung).
     */
    async flame(id, on) {
      checkId(id);
      let out;
      const task = await call(async (z) => {
        out = await (on ? z.startFlame(id) : z.stopFlame(id));
        return out?.task;
      });
      const t = out.timing ?? {};
      // Feuer-Notiz der Woche nachziehen (im Hintergrund, VCP-52): beim Stopp die Zeit,
      // beim Start die Flamme, die Zunder dabei beendet hat.
      onFlame?.(task, on);
      return {
        ...summary(task),
        running: Boolean(out.running),
        startedAt: task.flame_started_at ?? null,
        endedAt: task.flame_ended_at ?? null,
        timing: t.error ? String(t.error) : Boolean(t.used),
      };
    },

    /** Markiert eine Aufgabe als Phönix-Schritt einer Woche (`2026-W42`); leer entfernt die Markierung. */
    async setPhoenix(id, fire) {
      checkId(id);
      const week = String(fire ?? '').trim();
      if (week && !parseWeekId(week)) throw new ActionError(`„${week}“ ist keine Kalenderwoche`);
      const phoenix = week ? { role: 'feuer_schritt', fire: week } : null;
      return summary(await call((z) => z.updateTask(id, { phoenix })));
    },

    /**
     * Erfasst Text aus der Schnelleingabe. `captureId` (vom Formular, beim
     * Nachsenden aus dem Offline-Puffer die ID des Eintrags) macht doppeltes
     * Absenden harmlos. Liefert das Ergebnis des Capture-Routers.
     */
    /** `title` nur für Notizen (z. B. Report einer Folge); ohne heißt die Notiz nach Quelle und Zeit. */
    async capture({ text, title = null, captureId = null }) {
      const url = saveArticle && !title ? articleUrl(text) : null;
      if (url) {
        if (captureId && !CAPTURE_ID.test(captureId)) throw new ActionError('Ungültige Capture-ID');
        let saved;
        try {
          saved = await saveArticle({ url, clientId: captureId || null });
        } catch (err) {
          // FetchError trägt den passenden Status, ReadingError ist eine falsche Eingabe.
          throw new ActionError(err.message, err.status ?? 400);
        }
        const { doc, duplicate } = saved;
        if (!duplicate) logger.info?.(`Schnelleingabe → Lesestapel ${doc.url}`);
        return { kind: 'article', id: doc.id, title: doc.title ?? doc.url, duplicate };
      }
      const { inboxFolder } = settings.get();
      // Der Inbox-Ordner ist frei einstellbar; in einen vertraulichen oder
      // ausgeschlossenen Ordner schreibt das Cockpit trotzdem nicht.
      const probe = `${inboxFolder}/_.md`;
      if (policy.isExcluded(probe) || policy.sensitivityOf(probe)) {
        throw new ActionError(`Der Inbox-Ordner „${inboxFolder}“ ist vertraulich oder ausgeschlossen; dort legt das Cockpit nichts an`, 403);
      }
      const router = createCaptureRouter({
        capture: createCapture({ vaultPath, folder: inboxFolder }),
        zunder: zunder(),
        state,
        tz: settings.get().tz,
        now,
        logger,
      });
      let result;
      try {
        result = await router.route({ text, ...(title ? { title } : {}), source: 'cockpit', captureId: captureId || null });
      } catch (err) {
        if (err instanceof CaptureError) {
          if (err.status === 503) throw new ActionError('Für Aufgaben mit ! fehlt der Zunder-Zugang (Einstellungen → Zunder)', 503);
          throw new ActionError(err.message, err.status);
        }
        throw new ActionError(err.message, 502);
      }
      if (result.kind === 'note' && !result.duplicate) index?.applyChanges([result.path]);
      return result;
    },

    /**
     * Vorschau der Schnelleingabe, mit derselben Logik wie beim Anlegen:
     * `{ kind, summary, title?, due?, location?, phoenix?, notes? }`. Legt nichts an.
     */
    async previewCapture(text) {
      if (saveArticle && articleUrl(text)) return { kind: 'article', summary: 'Artikel · Lesestapel' };
      const router = createCaptureRouter({ capture: null, zunder: zunder(), state, tz: settings.get().tz, now, logger });
      return router.preview({ text: String(text ?? '').slice(0, 2000) });
    },

    /**
     * Offene Punkte einer Synthese als Aufgaben in die Zunder-Inbox. Der
     * Merkzettel (`state`) hält je Notiz und Punkt die angelegte Aufgabe fest,
     * gleich nach jedem Anlegen; ein zweiter Klick oder ein neuer Versuch nach
     * einem Fehler legt nichts doppelt an. Aufrufe laufen nacheinander, damit
     * auch zwei gleichzeitige Klicks den Merkzettel sehen. Liefert `{ created, existing }`.
     */
    synthesisTasks({ path, points }) {
      const job = async () => {
        const z = zunderOrFail();
        const name = path.replace(/\.md$/i, '');
        let created = 0;
        let existing = 0;
        for (const point of points) {
          // shortcut: Schlüssel ist Pfad + Wortlaut; nach Umbenennen der Notiz oder des Punkts entsteht eine neue Aufgabe, bei Bedarf über Zunder-`vault_links` abgleichen.
          const key = `synthese:${path}\n${point}`;
          if (state.get(key)) {
            existing += 1;
            continue;
          }
          let task;
          try {
            task = await z.createTask({ title: point, description: `Offener Punkt aus der Synthese [[${name}]] (\`${path}\`).\n\n_Angelegt im Vault Cockpit_`, vaultLinks: [path] });
          } catch (err) {
            throw new ActionError(`${created ? `${created} angelegt, dann: ` : ''}${err.message}`, 502);
          }
          state.set(key, task);
          created += 1;
        }
        return { created, existing };
      };
      const run = synthesisQueue.then(job);
      synthesisQueue = run.catch(() => {});
      return run;
    },
  };
  return { ...actions, capture: singleFlight(actions.capture) };
}

/**
 * Eine Erfassung je ID zur selben Zeit: Kommt dieselbe `captureId` noch einmal,
 * während die erste läuft (zwei Tabs senden den Offline-Puffer nach), wartet die
 * zweite auf das Ergebnis der ersten und gilt als Doppel, statt in Zunder eine
 * zweite Aufgabe anzulegen. Danach greift die Idempotenz des Capture-Routers.
 */
function singleFlight(capture) {
  const running = new Map();
  return async (input) => {
    const id = input?.captureId || null;
    if (!id) return capture(input);
    if (running.has(id)) return { ...(await running.get(id)), duplicate: true };
    const p = capture(input).finally(() => running.delete(id));
    running.set(id, p);
    return p;
  };
}
