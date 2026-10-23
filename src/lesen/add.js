import { randomUUID } from 'node:crypto';
import { ActionError } from '../cockpit/actions.js';
import { hidden } from '../web/render.js';
import { readingPage } from './pages.js';
import { savePdf, MAX_PDF } from './pdf.js';

/**
 * Seite `/lesen/hinzufuegen` (Adresse oder PDF) und Aktion `/aktion/lesen/pdf`
 * (VCP-69), eingebunden in src/lesen/http.js. `uploads` sagt src/web/http.js,
 * welche Aktion eine Datei (`multipart/form-data`) bis zu welcher Größe annimmt.
 * `asAction` macht Fehler aus dem Speicher zu Meldungen (aus http.js).
 */
export function addRoutes({ store, asAction, logger = console }) {
  return {
    pages: {
      '/lesen/hinzufuegen': async (ctx) => ({ html: renderAdd(ctx) }),
    },
    actions: {
      async '/aktion/lesen/pdf'(form, session) {
        const file = form.files?.get('datei');
        if (!file?.data?.length) throw new ActionError('Bitte eine PDF-Datei auswählen');
        const { doc, duplicate } = await asAction(() => savePdf({ store, data: file.data, filename: file.filename, origin: 'formular', clientId: form.get('cid') || null }));
        if (!duplicate) logger.info?.(`Lesestapel: PDF „${doc.title}“ gespeichert (${session.sub})`);
        return { message: `${duplicate ? 'Schon im Lesestapel' : 'Gespeichert'}: ${doc.title}`, doc: { id: doc.id, title: doc.title, status: doc.status } };
      },
    },
    uploads: { '/aktion/lesen/pdf': MAX_PDF + 64 * 1024 },
  };
}

/** Zwei Formulare: Adresse speichern (dieselbe Aktion wie im Eingang) und PDF hochladen. */
function renderAdd(ctx) {
  const fields = () => hidden({ csrf: ctx.write.csrf, back: ctx.write.back, cid: randomUUID() });
  const body = `<section>
  <h2>Adresse</h2>
  <form method="post" action="/aktion/lesen/speichern" class="lesen-save">
    ${fields()}
    <label class="lesen-url"><span class="sr-only">Adresse des Artikels</span><input type="url" name="url" required placeholder="https://… Artikel speichern" inputmode="url" autocomplete="off" spellcheck="false" enterkeyhint="go"></label>
    <button type="submit" class="btn primary">Speichern</button>
  </form>
</section>
<section>
  <h2>PDF</h2>
  <form method="post" action="/aktion/lesen/pdf" enctype="multipart/form-data" class="lesen-save">
    ${fields()}
    <label class="lesen-url"><span class="sr-only">PDF-Datei</span><input type="file" name="datei" accept="application/pdf,.pdf" required></label>
    <button type="submit" class="btn primary">Hochladen</button>
  </form>
  <p class="meta">Höchstens ${MAX_PDF / 1024 / 1024} MB. Gespeichert wird der Text, nicht die Datei; gescannte PDFs ohne Text gehen nicht.</p>
</section>`;
  return readingPage(ctx, { key: 'hinzufuegen', title: 'Hinzufügen', body });
}
