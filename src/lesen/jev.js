/**
 * Feed-Eingang vorsortieren mit einem Entscheidungsmodell (VCP-136, Pilot).
 *
 * Neue Feed-Einträge im Eingang bekommen ein Urteil, bevor Ruben sie sieht:
 * eine Auswahl `entscheidung` (lesen, stapel, weg, unklar) und eine Skala
 * `naehe` (wie nah an dem, was er gerade liest). Das Urteil ist nur Vorschlag
 * und Reihenfolge, es löst nie eine Aktion aus. Die Optionen sind dieselben
 * wie die Knöpfe im Eingang (`src/lesen/inbox.js`): Was Ruben dort wählt, wird
 * zum Label (`decision`), aus dem sich die Folgequote ergibt. „unklar“ ist
 * Pflicht, sonst liest das Modell fehlende Information als Nein.
 *
 * Schnittstelle: `decider.decide({ state, questions })` → `{ model, answers,
 * usage }` im Vertrag `POST /v1/systemone` (TypeSafe Jev, inzwischen auch von
 * anderen Anbietern und offenen Nachbauten bedient). `createJevDecider` ist
 * die einzige Umsetzung; ein anderer Anbieter mit demselben Vertrag braucht
 * nur eine andere `endpoint`-Adresse.
 *
 * Datenschutz: An das Modell gehen nur Titel, Quelle, Feed, Gruppe und der
 * Auszug öffentlicher Feed-Einträge, dazu die Titel der zuletzt behaltenen
 * Texte als Kontext. Nie Notizen aus dem Vault, nie Markierungen.
 *
 * Gespeichert wird die volle Verteilung samt Version (`store.saveTriage`),
 * nicht nur die `confidence`: Die ist laut Anbieter eine Formkennzahl der
 * Verteilung, keine Trefferquote. Schwellen kommen später aus Rubens eigenen
 * Entscheidungen, nicht aus diesem Wert.
 */

export const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
/** Gepinnte Version: Aliase wie `jev-latest` verschieben Antworten ohne Codeänderung. */
export const JEV_DEFAULT_MODEL = 'jev-1.14.0';
/** Aliase, die sich still ändern; in den Einstellungen abgelehnt. */
export const JEV_ALIASES = ['jev-latest', 'jev-preview'];
/** Herstellerangabe: 0,042 USD je Million Eingabe-Token, Ausgabe frei. */
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export const TRIAGE_CHOICES = ['lesen', 'stapel', 'weg', 'unklar'];
export const TRIAGE_LABELS = { lesen: 'Jetzt lesen', stapel: 'Stapel', weg: 'Weg', unklar: 'Unklar' };
const NEAR_LEVELS = [
  'Fremd: hat mit den zuletzt behaltenen Texten nichts zu tun',
  'Am Rand: berührt ein Thema nur nebenbei',
  'Nah: gehört zu einem Thema, das gerade gelesen wird',
  'Mitten drin: dasselbe Thema, eine neue Sicht darauf',
];

const QUESTIONS = {
  entscheidung: {
    type: 'choice',
    instructions:
      'Ein neuer Eintrag aus einem abonnierten Feed liegt im Eingang eines persönlichen Lesestapels. Der Leser will breites Wissen und Querverbindungen, kein Expertenwissen. Was würde er mit diesem Eintrag tun? Die Liste „zuletzt behalten“ zeigt, was er zuletzt lesen wollte.',
    criteria: {
      lesen: 'Sofort lesen: passt genau zu dem, was gerade zählt, oder ist ungewöhnlich gut',
      stapel: 'Später lesen: interessant, aber nicht jetzt',
      weg: 'Verwerfen: Werbung, Wiederholung, belanglos oder ohne Bezug zu seinen Themen',
      unklar: 'Aus Titel und Auszug nicht zu entscheiden',
    },
  },
  naehe: {
    type: 'score',
    instructions: 'Wie nah liegt der Eintrag an den zuletzt behaltenen Texten?',
    criteria: NEAR_LEVELS,
  },
};

export class JevError extends Error {
  constructor(message, status = null) {
    super(message);
    this.status = status;
  }
}

/**
 * Client für `POST /v1/systemone`. `key` und `model` aus den Einstellungen;
 * `fetchImpl` setzen Tests. Ein Aufruf kostet bei Jev einen Bruchteil eines Cents.
 */
export function createJevDecider({ key, model = JEV_DEFAULT_MODEL, endpoint = JEV_ENDPOINT, fetchImpl = fetch, timeoutMs = 20_000 }) {
  if (!key) throw new JevError('Jev braucht einen API-Key');
  return {
    model,
    async decide({ state, questions }) {
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ state, model, questions }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new JevError(`Jev nicht erreichbar: ${err?.message ?? err}`);
      }
      const text = await res.text();
      if (!res.ok) throw new JevError(`Jev antwortet ${res.status}: ${text.slice(0, 200)}`, res.status);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new JevError('Jev antwortet kein JSON');
      }
      if (!body || typeof body.answers !== 'object') throw new JevError('Jev antwortet ohne answers');
      return { model: typeof body.model === 'string' ? body.model : model, answers: body.answers, usage: body.usage ?? {} };
    },
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Verteilung als `{ label: Zahl }`, nur bekannte Schlüssel. */
const distribution = (p, keys) => Object.fromEntries(keys.map((k) => [k, num(p?.[k]) ?? 0]));

/**
 * Antwort → Zeile für `store.saveTriage`. Fehlt `choice`, gilt die Option mit
 * der höchsten Wahrscheinlichkeit. Die Skala kommt als Position 0…n−1
 * (`score`), die Verteilung je Stufe unter ihrem Index.
 */
export function triageFromAnswers({ model, answers, usage }) {
  const a = answers?.entscheidung;
  if (!a || typeof a !== 'object') throw new JevError('Jev antwortet ohne Entscheidung');
  const probabilities = distribution(a.probabilities, TRIAGE_CHOICES);
  const best = Object.entries(probabilities).sort((x, y) => y[1] - x[1])[0][0];
  const choice = TRIAGE_CHOICES.includes(a.choice) ? a.choice : best;
  const n = answers?.naehe;
  const near = num(n?.score);
  const nearProbabilities = n?.probabilities && typeof n.probabilities === 'object' ? Object.fromEntries(NEAR_LEVELS.map((_, i) => [String(i), num(n.probabilities[i]) ?? num(n.probabilities[String(i)]) ?? 0])) : null;
  return {
    model,
    choice,
    probabilities,
    confidence: num(a.confidence),
    near,
    near_max: NEAR_LEVELS.length - 1,
    near_probabilities: nearProbabilities,
    input_tokens: num(usage?.input_tokens) ?? 0,
    rank: rankOf(probabilities, near),
  };
}

/**
 * Reihenfolge im Eingang, höher zuerst: „lesen“ zählt doppelt, „stapel“ einfach,
 * „weg“ zieht ab; die Nähe (0…1) entscheidet bei ähnlicher Verteilung.
 * Eine Schwelle ist das bewusst nicht.
 */
export function rankOf(p, near) {
  const closeness = near == null ? 0 : near / (NEAR_LEVELS.length - 1);
  return 2 * p.lesen + p.stapel - p.weg + 0.25 * closeness;
}

/** Was an das Modell geht: nur öffentliche Angaben zum Eintrag, kein Vault. */
export function triageState(doc, { feed = null, group = null, kept = [] } = {}) {
  return {
    titel: doc.title || doc.url,
    quelle: doc.site ?? null,
    feed: feed?.title ?? null,
    gruppe: group ?? null,
    lesezeit_min: doc.reading_minutes || null,
    auszug: String(doc.excerpt ?? '').slice(0, 1200) || null,
    zuletzt_behalten: kept.slice(0, 12),
  };
}

/** Nach so vielen gescheiterten Versuchen bleibt ein Eintrag ohne Urteil. */
const MAX_ATTEMPTS = 3;

/**
 * Hintergrunddienst. `decider()` liefert den aktuellen Client oder `null`
 * (kein Key: nichts passiert, der Eingang bleibt, wie er ist). `runPending`
 * urteilt über höchstens `batch` Feed-Einträge im Eingang ohne Urteil, einer
 * nach dem anderen; ein Fehler bleibt am Eintrag (`error`, `attempts`).
 */
export function createFeedTriage({ store, decider, batch = 20, now = () => Date.now(), logger = console }) {
  let timer = null;
  let running = null;
  let last = { okAt: null, errorAt: null, error: null };
  const iso = () => new Date(now()).toISOString();

  async function judge(d, doc) {
    const feed = doc.origin?.startsWith('feed:') ? store.getFeed(doc.origin.slice(5)) : null;
    const group = feed?.group_id ? store.listGroups?.().find((g) => g.id === feed.group_id)?.name ?? null : null;
    const state = triageState(doc, { feed, group, kept: store.recentKeptTitles(12) });
    try {
      const row = triageFromAnswers(await d.decide({ state, questions: QUESTIONS }));
      store.saveTriage(doc.id, { ...row, error: null, judged_at: iso() });
      last = { ...last, okAt: iso() };
      return true;
    } catch (err) {
      store.saveTriageError(doc.id, String(err?.message ?? err));
      last = { ...last, errorAt: iso(), error: String(err?.message ?? err) };
      logger.warn?.(`Vorsortieren: ${doc.title ?? doc.url} ohne Urteil: ${err?.message ?? err}`);
      // Schlüssel falsch oder Kontingent leer: nicht weiter anfragen in diesem Durchgang.
      if (err?.status === 401 || err?.status === 403 || err?.status === 429) throw err;
      return false;
    }
  }

  /** Ein Durchgang; läuft schon einer, wartet man auf ihn. Liefert die Zahl neuer Urteile. */
  function runPending() {
    const d = decider();
    if (!d) return Promise.resolve(0);
    if (running) return running;
    running = (async () => {
      let judged = 0;
      for (const doc of store.pendingTriage({ limit: batch, maxAttempts: MAX_ATTEMPTS })) {
        if (await judge(d, doc)) judged += 1;
      }
      if (judged) logger.info?.(`Vorsortieren: ${judged} Feed-Einträge beurteilt`);
      return judged;
    })()
      .catch(() => 0)
      .finally(() => {
        running = null;
      });
    return running;
  }

  /** Zustand für /zustand: Folgequote, Menge, Kosten. Ohne Key: aus. */
  function health() {
    const base = { id: 'vorsortieren', name: 'Vorsortieren (Jev)' };
    const d = decider();
    if (!d) return { ...base, state: 'off', summary: 'aus, kein API-Key', facts: [] };
    const s = store.triageStats();
    const rate = s.decided ? Math.round((100 * s.followed) / s.decided) : null;
    const failing = last.errorAt && (!last.okAt || last.errorAt > last.okAt);
    return {
      ...base,
      state: failing ? 'error' : last.okAt || s.judged ? 'ok' : 'unknown',
      summary: rate == null ? `${s.judged} beurteilt, noch keine Entscheidung` : `Vorschlag ${rate} % befolgt (${s.followed} von ${s.decided})`,
      lastOkAt: last.okAt,
      lastErrorAt: last.errorAt,
      lastError: last.error,
      facts: [
        { label: 'Modell', value: d.model },
        { label: 'Beurteilt', value: String(s.judged) },
        { label: 'Entschieden', value: String(s.decided) },
        { label: 'Befolgt', value: rate == null ? '–' : `${rate} %` },
        { label: 'Unklar', value: String(s.unclear) },
        { label: 'Kosten bisher', value: `${(s.input_tokens * USD_PER_INPUT_TOKEN).toFixed(4)} USD` },
      ],
    };
  }

  return {
    runPending,
    health,
    /** Jede Minute nachsehen, ob neue Feed-Einträge ohne Urteil im Eingang liegen. */
    start(tickMinutes = 1) {
      runPending();
      timer = setInterval(runPending, tickMinutes * 60_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
