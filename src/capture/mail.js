import { createHash } from 'node:crypto';

/**
 * Capture per Mail: holt Mails aus einem Postfach-Ordner über JMAP (Fastmail).
 *
 * Gedacht ist eine eigene Adresse (Alias), deren Mails eine Regel in Fastmail in
 * einen Ordner (Standard „Vault“) sortiert. Das Cockpit fragt diesen Ordner
 * regelmäßig ab, macht aus jeder Mail eine Notiz (Betreff = Titel) oder mit `!`
 * im Betreff eine Zunder-Aufgabe und verschiebt die Mail danach in einen
 * Erledigt-Ordner (Standard „Archive“). Scheitert eine Mail, bleibt sie liegen
 * und kommt beim nächsten Abruf wieder dran.
 *
 * Nur Absender aus `allowedSenders` werden zu Notizen oder Aufgaben (Adresse oder
 * mit führendem `@` eine ganze Domain ohne Subdomains), damit eine fremde Mail an
 * die Adresse beides nie erzeugt.
 *
 * `readingMail` (`{ matches(email), save(email) }`, src/lesen/mail.js) nimmt
 * Mails mit `[lesen]` im Betreff oder `>` vorn statt des Routers: Sie gehen in den
 * Lesestapel. Mit `readingMail` landen auch Mails fremder Absender dort (direkt
 * abonnierte Newsletter); ohne werden sie unverarbeitet verschoben.
 */
const MAIL = 'urn:ietf:params:jmap:mail';
// Längster Mail-Teil, den der Abruf ganz nachholt (lange Newsletter).
const MAX_BLOB = 5 * 1024 * 1024;

const decodePart = (buf, charset) => {
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
};
const USING = ['urn:ietf:params:jmap:core', MAIL];

export function createMailCapture({
  token,
  sessionUrl = 'https://api.fastmail.com/jmap/session',
  mailbox = 'Vault',
  doneMailbox = 'Archive',
  allowedSenders,
  router,
  readingMail = null,
  fetch = globalThis.fetch,
  batch = 20,
  logger = console,
}) {
  const isAllowed = senderFilter(allowedSenders);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  let session = null;
  let timer = null;
  let running = null;
  // Letzter Abruf für die Zustandsseite: `state` ist idle (noch keiner), ok oder
  // error; `error` bleibt nach einem Erfolg als „letzter Fehler“ stehen.
  let last = { state: 'idle', at: null, okAt: null, processed: 0, error: null, errorAt: null };

  async function ensureSession() {
    if (session) return session;
    const res = await fetch(sessionUrl, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`JMAP-Session: HTTP ${res.status}`);
    const s = await res.json();
    if (!s.primaryAccounts?.[MAIL]) throw new Error('JMAP-Session ohne Mail-Konto');
    session = { apiUrl: s.apiUrl, downloadUrl: s.downloadUrl ?? null, accountId: s.primaryAccounts[MAIL] };
    return session;
  }

  async function jmap(methodCalls) {
    await ensureSession();
    const res = await fetch(session.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ using: USING, methodCalls }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      if (res.status === 401) session = null;
      throw new Error(`JMAP: HTTP ${res.status}`);
    }
    const { methodResponses } = await res.json();
    for (const [name, args] of methodResponses) {
      if (name === 'error') throw new Error(`JMAP: ${args.type}${args.description ? ` (${args.description})` : ''}`);
    }
    return methodResponses;
  }

  async function mailboxIds() {
    const [[, { list }]] = await jmap([['Mailbox/get', { accountId: session.accountId, properties: ['name', 'role'] }, 'm']]);
    const find = (name) => list.find((m) => m.name === name) ?? list.find((m) => m.role && m.role === name.toLowerCase());
    const source = find(mailbox);
    const done = find(doneMailbox);
    if (!source) throw new Error(`Postfach-Ordner "${mailbox}" nicht gefunden`);
    if (!done) throw new Error(`Postfach-Ordner "${doneMailbox}" nicht gefunden`);
    return { source: source.id, done: done.id };
  }

  /**
   * Abgeschnittene Teile (`isTruncated`, über `maxBodyValueBytes`) ganz holen:
   * den Blob des Teils über `downloadUrl`, höchstens `MAX_BLOB` Bytes, im
   * Zeichensatz des Teils. Klappt das nicht, bleibt der gekürzte Text.
   */
  async function completeBodies(email) {
    const parts = [...(email.textBody ?? []), ...(email.htmlBody ?? [])].filter((p) => email.bodyValues?.[p.partId]?.isTruncated && p.blobId);
    if (!parts.length || !session.downloadUrl) return email;
    const bodyValues = { ...email.bodyValues };
    for (const part of parts) {
      try {
        const url = session.downloadUrl
          .replace('{accountId}', encodeURIComponent(session.accountId))
          .replace('{blobId}', encodeURIComponent(part.blobId))
          .replace('{type}', encodeURIComponent(part.type ?? 'application/octet-stream'))
          .replace('{name}', encodeURIComponent(part.name ?? 'teil'));
        // Der Token geht nur über https mit.
        if (new URL(url).protocol !== 'https:') throw new Error('Download-Adresse ohne https');
        const res = await fetch(url, { headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (Number(res.headers.get?.('content-length')) > MAX_BLOB) throw new Error('zu groß');
        // Mitzählen statt erst alles zu puffern: Ohne Content-Length gäbe es sonst keine Grenze.
        const chunks = [];
        let size = 0;
        for await (const chunk of res.body ?? []) {
          size += chunk.length;
          if (size > MAX_BLOB) throw new Error('zu groß');
          chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);
        bodyValues[part.partId] = { value: decodePart(buf, part.charset), isTruncated: false };
      } catch (err) {
        logger.warn?.(`Mail-Capture: Teil ${part.partId} von Mail ${email.id} nur gekürzt (${err.message})`);
      }
    }
    return { ...email, bodyValues };
  }

  async function poll() {
    await ensureSession();
    const ids = await mailboxIds();
    const accountId = session.accountId;
    const responses = await jmap([
      ['Email/query', { accountId, filter: { inMailbox: ids.source }, sort: [{ property: 'receivedAt', isAscending: true }], limit: batch }, 'q'],
      [
        'Email/get',
        {
          accountId,
          '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
          properties: ['id', 'messageId', 'from', 'subject', 'receivedAt', 'textBody', 'htmlBody', 'bodyValues'],
          fetchTextBodyValues: true,
          // HTML für Newsletter im Lesestapel; was JMAP abschneidet, holt `completeBodies` als Blob nach.
          fetchHTMLBodyValues: Boolean(readingMail),
          maxBodyValueBytes: readingMail ? 500_000 : 100_000,
        },
        'g',
      ],
    ]);
    const emails = responses.find(([name]) => name === 'Email/get')?.[1]?.list ?? [];

    let processed = 0;
    const failures = [];
    for (const email of emails) {
      const sender = String(email.from?.[0]?.email ?? '').toLowerCase();
      try {
        if (!isAllowed(sender)) {
          // Direkt abonnierte Newsletter: fremde Absender landen im Lese-Eingang, nie als Notiz oder Aufgabe,
          // und lösen keinen Abruf einer Adresse aus.
          if (readingMail) {
            await readingMail.save(await completeBodies(email), { fetch: false });
            processed += 1;
          } else logger.warn?.(`Mail-Capture: Absender nicht freigegeben, Mail wird nur verschoben (${email.id})`);
        } else if (readingMail?.matches(email)) {
          await readingMail.save(await completeBodies(email));
          processed += 1;
        } else {
          await router.route(toCapture(email));
          processed += 1;
        }
        await jmap([
          ['Email/set', { accountId, update: { [email.id]: { mailboxIds: { [ids.done]: true }, 'keywords/$seen': true } } }, 's'],
        ]);
      } catch (err) {
        failures.push(err.message);
        logger.error?.(`Mail-Capture: Mail ${email.id} bleibt liegen: ${err.message}`);
      }
    }
    return { processed, failures };
  }

  async function runOnce() {
    if (running) return running;
    running = poll()
      .then(({ processed, failures }) => {
        const at = new Date().toISOString();
        // Liegengebliebene Mails zählen als Fehler, auch wenn der Abruf selbst ging.
        last = failures.length
          ? { ...last, state: 'error', at, processed, error: `${failures.length === 1 ? '1 Mail bleibt' : `${failures.length} Mails bleiben`} liegen: ${failures[0]}`, errorAt: at }
          : { ...last, state: 'ok', at, okAt: at, processed };
        return processed;
      })
      .catch((err) => {
        const at = new Date().toISOString();
        last = { ...last, state: 'error', at, processed: 0, error: err.message, errorAt: at };
        logger.error?.(`Mail-Capture: Abruf fehlgeschlagen: ${err.message}`);
        return 0;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    runOnce,
    start(intervalMinutes = 5) {
      runOnce();
      timer = setInterval(runOnce, intervalMinutes * 60_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    status: () => ({
      state: last.state,
      mailbox,
      lastPollAt: last.at,
      lastOkAt: last.okAt,
      lastProcessed: last.processed,
      lastError: last.error,
      lastErrorAt: last.errorAt,
    }),
  };
}

/**
 * Prüffunktion für freigegebene Absender. Ein Eintrag wie `r@rubeen.dev` gilt
 * genau für diese Adresse, `@rubeen.dev` für jede Adresse dieser Domain, aber
 * nicht für Subdomains wie `x@sub.rubeen.dev`.
 */
export function senderFilter(allowedSenders) {
  const entries = allowedSenders.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!entries.length) throw new Error('MAIL_ALLOWED_SENDERS enthält keinen Absender');
  const addresses = new Set(entries.filter((e) => !e.startsWith('@')));
  const domains = new Set(entries.filter((e) => e.startsWith('@')).map((e) => e.slice(1)));
  return (sender) => {
    const at = sender.lastIndexOf('@');
    if (at <= 0) return false;
    return addresses.has(sender) || domains.has(sender.slice(at + 1));
  };
}

/** Mail → Eingabe für den Capture-Router. */
export function toCapture(email) {
  const subject = String(email.subject ?? '').trim();
  const body = (email.textBody ?? [])
    .map((part) => email.bodyValues?.[part.partId]?.value ?? '')
    .join('\n')
    .replace(/\r\n/g, '\n')
    .trim();
  const created = email.receivedAt ? new Date(email.receivedAt) : null;
  const captureId = `mail-${createHash('sha256').update(String(email.messageId?.[0] ?? email.id)).digest('hex').slice(0, 32)}`;

  // `!` im Betreff: Betreff wird Aufgabentitel, der Text die Beschreibung.
  if (subject.startsWith('!')) {
    return { text: `${subject}\n${body}`, source: 'mail', captureId, created };
  }
  return { text: body || subject, title: subject || null, source: 'mail', captureId, created };
}
