import { esc, head, icon } from './layout.js';

/**
 * Abschnitt „Anmeldung“ der Einstellungsseite, innerhalb des großen
 * Formulars: Dauer der Sitzung (leer = Standard) und „Überall abmelden“. Der
 * Knopf gehört über `form=` zu einem eigenen Formular (`revokeForm`), damit
 * „Speichern“ die Sitzungen nie berührt und umgekehrt.
 */
export function sessionSection(stored, d) {
  const s = stored.session ?? {};
  return `<section id="anmeldung">
  <h2>Anmeldung</h2>
  <p class="meta">Jede Nutzung verlängert die Anmeldung. Sie endet erst nach einer Pause ohne Nutzung oder spätestens nach der Obergrenze; dann folgt wieder der Login bei Pocket ID.</p>
  <div class="grid">
    <label><span>Abmelden nach <span class="hint">Tagen ohne Nutzung</span></span><input name="session.idleDays" inputmode="numeric" value="${esc(s.idleDays ?? '')}" placeholder="${esc(d.sessionIdleDays)}"></label>
    <label><span>Spätestens neu anmelden <span class="hint">nach Tagen</span></span><input name="session.maxDays" inputmode="numeric" value="${esc(s.maxDays ?? '')}" placeholder="${esc(d.sessionMaxDays)}"></label>
  </div>
  <p><button type="submit" form="abmelden-ueberall" class="btn quiet danger">Überall abmelden</button> <span class="meta">Beendet die Anmeldung auf allen Geräten, auch hier.</span></p>
</section>`;
}

/** Das Formular hinter „Überall abmelden“; steht außerhalb des großen Formulars. */
export const revokeForm = (token) => `<form method="post" action="/einstellungen/abmelden" id="abmelden-ueberall" hidden>${token}</form>`;

/**
 * Sitzung abgelaufen und der Text passt nicht ins Cookie für den Login (oder
 * die Herkunft ist unklar): Die Seite zeigt ihn zum Kopieren, nichts geht verloren.
 */
export function renderDraftRescue(text, loginHref) {
  return `<!doctype html>
<html lang="de">
${head('Anmeldung abgelaufen')}
<body class="page-message"><main class="message"><a href="/" class="brand" aria-label="Cockpit">${icon('flame', 'brand-mark')}<span class="brand-name">Cockpit</span></a><h1>Anmeldung abgelaufen</h1><p>Nichts gespeichert. Kopiere den Text, melde dich neu an und füge ihn wieder ein.</p><textarea readonly rows="8" aria-label="Dein Text">${esc(text)}</textarea><p><a href="${esc(loginHref)}" class="btn primary">Neu anmelden</a></p></main></body>
</html>`;
}
