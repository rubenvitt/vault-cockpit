import { createCapture } from '../vault/capture.js';
import { createCaptureRouter, CaptureError } from '../capture/router.js';

/** Status, die das Cockpit setzen darf: abhaken, zurücknehmen, anfangen, parken. */
export const SETTABLE = ['open', 'in_progress', 'blocked', 'done'];

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
 * aus den Einstellungen.
 *
 * Zunder-Zugang und Inbox-Ordner werden bei jedem Aufruf frisch gelesen, damit
 * eine Änderung unter `/einstellungen` sofort gilt.
 */
export function createCockpitActions({ vaultPath, settings, policy, state, zunder, index = null, logger = console }) {
  const zunderOrFail = () => {
    const z = zunder();
    if (!z) throw new ActionError('Zunder ist nicht eingerichtet (Einstellungen → Zunder)', 503);
    return z;
  };

  return {
    /** Setzt den Status einer Zunder-Aufgabe und liefert `{ id, ref, title, status }`. */
    async setStatus(id, status) {
      if (!TASK_ID.test(String(id ?? ''))) throw new ActionError('Unbekannte Aufgabe');
      if (!SETTABLE.includes(status)) throw new ActionError(`Status „${status}“ ist hier nicht vorgesehen`);
      const z = zunderOrFail();
      let task;
      try {
        task = await z.setStatus(id, status);
      } catch (err) {
        throw new ActionError(err.message, 502);
      }
      if (!task) throw new ActionError('Zunder hat die Aufgabe nicht zurückgegeben', 502);
      return { id: task.id, ref: task.ref ?? null, title: task.title, status: task.status };
    },

    /**
     * Erfasst Text aus der Schnelleingabe. `captureId` (vom Formular) macht
     * doppeltes Absenden harmlos. Liefert das Ergebnis des Capture-Routers.
     */
    async capture({ text, captureId = null }) {
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
        logger,
      });
      let result;
      try {
        result = await router.route({ text, source: 'cockpit', captureId: captureId || null });
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
  };
}
