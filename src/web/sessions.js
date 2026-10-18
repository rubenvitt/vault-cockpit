import { randomUUID } from 'node:crypto';
import { parseCookies, cookie } from './session.js';

export const SESSION_COOKIE = 'vc_session';
const DRAFT_COOKIE = 'vc_draft';
const DAY = 86_400;
/** Eine aktive Sitzung bekommt höchstens einmal pro Stunde ein frisches Cookie. */
const RENEW_AFTER = 3600;
/** So lange wartet ein Entwurf auf den Login. */
const DRAFT_SECONDS = 15 * 60;
/** Größere Cookies speichern Safari und Proxys (nginx: 8 KB für alle) nicht verlässlich. */
const MAX_DRAFT_COOKIE = 3800;

/**
 * Sitzungen des Web-Cockpits: ausstellen, prüfen, gleitend verlängern und
 * alle auf einmal widerrufen. Weiter ohne Speicher auf dem Server, alles
 * steht im signierten Cookie:
 *
 * - `iat` ist der Login, `seen` die letzte Verlängerung. Gültig ist eine
 *   Sitzung, solange seit `seen` weniger als die Inaktivitätsdauer und seit
 *   `iat` weniger als die Obergrenze vergangen ist. Beides kommt bei jeder
 *   Prüfung aus den Einstellungen, eine kürzere Dauer wirkt also sofort.
 * - `gen` muss zur Generation in den Einstellungen passen. „Überall abmelden“
 *   zählt sie hoch, damit gilt kein bestehendes Cookie mehr.
 * - `sid` ist je Login neu; daran hängt das CSRF-Token, damit es beim
 *   Verlängern nicht wechselt und offene Seiten weiter speichern können.
 *
 * Dazu der Entwurf über den Login: Läuft die Sitzung ab, während man etwas
 * abschickt, liegt der Text verschlüsselt in einem kurzlebigen Cookie und
 * kommt nach dem Login wieder ins Feld. Er geht nie in eine URL, also weder
 * zu Pocket ID noch in ein Zugriffslog.
 */
export function createSessions({ signer, settings, allowedSubjects = [], secure = true, now = () => Date.now() }) {
  const seconds = () => Math.floor(now() / 1000);

  const limits = () => {
    const s = settings.get().session;
    return { idle: Math.min(s.idleDays, s.maxDays) * DAY, max: s.maxDays * DAY, generation: s.generation };
  };

  function sessionCookie(s, t) {
    const { idle, max } = limits();
    const exp = Math.min(t + idle, s.iat + max);
    return cookie(SESSION_COOKIE, signer.seal({ ...s, seen: t, exp }), { secure, maxAge: Math.max(0, exp - t) });
  }

  return {
    /** Set-Cookie für einen frischen Login. */
    issue({ subject, name }) {
      const t = seconds();
      return sessionCookie({ sub: subject, name, sid: randomUUID(), gen: limits().generation, iat: t }, t);
    },

    /**
     * Die gültige Sitzung des Requests oder null. Das Subject wird erneut
     * geprüft, damit ein aus ALLOWED_SUBJECTS gestrichener Account nicht bis
     * zum Ablauf seines Cookies weiter hineinkommt. Cookies im alten Format
     * (ohne `gen`, `iat`, `seen`) gelten nicht mehr.
     */
    read(req) {
      const s = signer.open(parseCookies(req.headers.cookie)[SESSION_COOKIE], now());
      if (!s || typeof s.sub !== 'string' || typeof s.sid !== 'string' || !Number.isInteger(s.iat) || !Number.isInteger(s.seen)) return null;
      if (allowedSubjects.length && !allowedSubjects.includes(s.sub)) return null;
      const { idle, max, generation } = limits();
      const t = seconds();
      if (s.gen !== generation || t >= s.seen + idle || t >= s.iat + max) return null;
      return s;
    },

    /** Hängt bei aktiver Nutzung ein verlängertes Cookie an die Antwort. */
    renew(res, s) {
      const t = seconds();
      if (t - s.seen >= RENEW_AFTER) res.appendHeader('set-cookie', sessionCookie(s, t));
    },

    clear: () => cookie(SESSION_COOKIE, '', { secure, maxAge: 0 }),

    /** CSRF-Token der Sitzung: an den Login gebunden, nicht an das einzelne Cookie. */
    csrf: (s) => signer.mac(`csrf\n${s.sid}`),

    /** „Überall abmelden“: neue Generation, alle bestehenden Sitzungen enden. */
    revokeAll() {
      const stored = settings.stored();
      settings.save({ ...stored, session: { ...stored.session, generation: stored.session.generation + 1 } });
    },

    /**
     * Entwurf für die Zeit des Logins ablegen. `false`, wenn er nicht in ein
     * Cookie passt; dann muss die Seite den Text anders retten.
     */
    keepDraft(res, { action, back, text }) {
      const value = signer.encrypt({ action, back, text, exp: seconds() + DRAFT_SECONDS });
      if (value.length > MAX_DRAFT_COOKIE) return false;
      res.appendHeader('set-cookie', cookie(DRAFT_COOKIE, value, { secure, maxAge: DRAFT_SECONDS }));
      return true;
    },

    /**
     * Den abgelegten Entwurf holen, wenn `fits` ihn für diese Seite annimmt;
     * er wird dabei gelöscht. Einer für eine andere Seite bleibt liegen.
     */
    takeDraft(req, res, fits) {
      const raw = parseCookies(req.headers.cookie)[DRAFT_COOKIE];
      if (!raw) return null;
      const draft = signer.decrypt(raw, now());
      const usable = draft && typeof draft.text === 'string';
      if (usable && !fits(draft)) return null;
      res.appendHeader('set-cookie', cookie(DRAFT_COOKIE, '', { secure, maxAge: 0 }));
      return usable ? draft : null;
    },
  };
}
