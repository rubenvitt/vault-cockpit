import { createHash } from 'node:crypto';
import { esc } from '../web/layout.js';
import { sanitizeHtml, textFields } from './extract.js';
import { FetchError } from './fetch.js';
import { saveUrl } from './save.js';

/**
 * Mails für den Lesestapel (VCP-69), abgeholt vom Mail-Abruf
 * (src/capture/mail.js) aus demselben Ordner und mit derselben
 * Absender-Freigabe wie Notizen. Erkannt an `[lesen]` irgendwo im Betreff
 * (übersteht „Fwd:“) oder `>` vorn.
 *
 * - Steht in der Mail nur eine Adresse, wird diese Adresse gespeichert
 *   (`saveUrl`, SSRF-geschützt), Herkunft `mail`.
 * - Sonst wird die Mail selbst das Dokument (`kind: 'newsletter'`): der
 *   HTML-Body über `sanitizeHtml` (kein Skript, Zählpixel fallen weg, Bilder
 *   werden Links), ohne HTML der Text in Absätzen. Adresse ist `mid:<Message-ID>`
 *   (RFC 2392), die Artikel-Adresse wird nicht geholt.
 *
 * Lässt sich die eine Adresse nicht holen (404, kein HTML, lokal …), wird die
 * Mail mit dem Link als Dokument gespeichert, statt bei jedem Abruf wieder
 * liegen zu bleiben. Idempotent über die Message-ID (`client_id`).
 */

const MARK = /\[lesen\]/i;

export const isReadingMail = (email) => {
  const subject = String(email.subject ?? '');
  return MARK.test(subject) || subject.trimStart().startsWith('>');
};

const bodyOf = (email, parts, type = null) =>
  (parts ?? [])
    .filter((p) => !type || p.type === type)
    .map((p) => email.bodyValues?.[p.partId]?.value ?? '')
    .join('\n')
    .replace(/\r\n/g, '\n')
    .trim();

/** Klartext in Absätze: Leerzeilen trennen, einfache Umbrüche bleiben. */
const paragraphs = (text) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

/** `store`: Lesestapel; `fetchPage` nur für Tests. Liefert `{ matches, save }` für den Mail-Abruf. */
export function createMailReader({ store, fetchPage = undefined, logger = console }) {
  async function save(email) {
    const subject = String(email.subject ?? '').replace(MARK, ' ').replace(/^\s*>/, '').replace(/\s+/g, ' ').trim();
    const messageId = String(email.messageId?.[0] ?? email.id);
    const clientId = `mail-${createHash('sha256').update(messageId).digest('hex').slice(0, 32)}`;
    const text = bodyOf(email, email.textBody);
    const html = bodyOf(email, email.htmlBody, 'text/html');
    let content = textFields(html ? sanitizeHtml(html) : paragraphs(text));

    const only = /^https?:\/\/\S+$/i.exec((text || content.content_text || subject).trim())?.[0];
    if (only) {
      try {
        return await saveUrl({ store, url: only, origin: 'mail', clientId, ...(fetchPage ? { fetchPage } : {}) });
      } catch (err) {
        if (!(err instanceof FetchError)) throw err;
        logger.warn?.(`Lesestapel: ${only} aus einer Mail nicht holbar (${err.message}), speichere die Mail`);
        content = textFields(sanitizeHtml(`<p><a href="${esc(only)}">${esc(only)}</a></p>`));
      }
    }
    const from = email.from?.[0] ?? {};
    const sender = String(from.email ?? '').toLowerCase();
    return store.addDocument({
      url: `mid:${encodeURIComponent(messageId.replace(/^<|>$/g, ''))}`,
      title: subject || from.name || 'Newsletter',
      author: from.name || sender || null,
      site: sender.includes('@') ? sender.slice(sender.lastIndexOf('@') + 1) : null,
      kind: 'newsletter',
      origin: 'mail',
      client_id: clientId,
      ...content,
    });
  }
  return { matches: isReadingMail, save };
}
