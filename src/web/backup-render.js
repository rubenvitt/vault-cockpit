import { esc } from './layout.js';
import { MIN_PASSPHRASE } from '../cockpit/backup.js';

/**
 * Abschnitt „Sicherung“ der Einstellungsseite: verschlüsselte Sicherung der
 * Dateien unter `/data` herunterladen und wiederherstellen. `status` kommt von
 * `createBackup().status()`, `token` ist das versteckte CSRF-Feld.
 */
export function backupSection(status, token) {
  const files = status.files.map((f) => `<li><code>${esc(f.name)}</code> ${esc(f.label)}${f.present ? '' : ' <span class="meta">(noch nicht da)</span>'}</li>`).join('');
  return `<section id="sicherung">
  <h2>Sicherung</h2>
  <p class="meta">Index und Vektoren baut das Cockpit nach einem Verlust von <code>/data</code> selbst neu, diese Dateien nicht. Die Sicherung enthält sie mit einer Passphrase verschlüsselt (scrypt und AES-256-GCM); ohne die Passphrase lässt sie sich nicht öffnen, auch nicht vom Cockpit. Einfacher ist ein Backup des Volumes auf dem Host.</p>
  <ul>${files}</ul>
  <form method="post" action="/einstellungen/sicherung">${token}
    <div class="grid">
      <label><span>Passphrase <span class="hint">mindestens ${MIN_PASSPHRASE} Zeichen</span></span><input name="passphrase" type="password" autocomplete="new-password" minlength="${MIN_PASSPHRASE}" required></label>
      <label>Passphrase wiederholen<input name="passphrase2" type="password" autocomplete="new-password" minlength="${MIN_PASSPHRASE}" required></label>
    </div>
    <p><button type="submit" class="primary">Sicherung herunterladen</button></p>
  </form>
  <h3>Wiederherstellen</h3>
  <p class="meta">${status.empty ? 'Das Cockpit ist noch leer (keine Einstellungen, keine API-Tokens): Sicherung wählen, Passphrase eingeben, fertig.' : 'Ersetzt Einstellungen, API-Tokens und Merkzettel durch den Stand der Sicherung.'} Danach startet das Cockpit neu; weil das Sitzungs-Secret mit zurückkommt, meldet man sich anschließend neu an.</p>
  <form method="post" action="/einstellungen/sicherung/wiederherstellen" enctype="multipart/form-data">${token}
    <div class="grid">
      <label>Sicherungsdatei<input name="datei" type="file" accept=".json,application/json" required></label>
      <label>Passphrase<input name="passphrase" type="password" autocomplete="off" required></label>
    </div>
    ${status.empty ? '' : '<label class="checkline"><input type="checkbox" name="ersetzen" value="1" required> Vorhandenes ersetzen</label>'}
    <p><button type="submit" class="${status.empty ? 'primary' : 'btn danger'}">Wiederherstellen</button></p>
  </form>
</section>`;
}

/** Hinweis oben auf der Einstellungsseite, solange das Cockpit leer ist. */
export const backupHint = (status) =>
  status?.empty ? '<p class="notice">Neu eingerichtet? Eine Sicherung lässt sich unter <a href="#sicherung">Sicherung</a> wiederherstellen.</p>' : '';

/** Text der Seite nach dem Wiederherstellen. */
export function restoredMessage(result, tz = 'Europe/Berlin') {
  const when = new Date(result.createdAt);
  const date = Number.isNaN(when.getTime()) ? '' : ` vom ${when.toLocaleString('de-DE', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' })}`;
  const relogin = result.files.includes('session-secret');
  const n = result.files.length;
  const text =
    `${n === 1 ? 'Eine Datei' : `${n} Dateien`} aus der Sicherung${date} zurückgeschrieben: ${result.files.join(', ')}.` +
    `${result.skipped.length ? ` Unbekannt und übergangen: ${result.skipped.join(', ')}.` : ''}` +
    ' Das Cockpit startet jetzt neu und liest sie ein.' +
    (relogin ? ' Die Anmeldung gilt danach nicht mehr: in ein paar Sekunden neu anmelden.' : '');
  return { title: 'Sicherung wiederhergestellt', text, link: relogin ? { href: '/login?next=%2Feinstellungen', label: 'Neu anmelden' } : { href: '/einstellungen', label: 'Zu den Einstellungen' } };
}
