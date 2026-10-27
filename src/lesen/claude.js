import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Claude als Autor im Hintergrund (Folgen „Podcast“ und „Report“,
 * src/lesen/folgen.js): ruft die Claude Code CLI headless auf
 * (`claude -p`), mit dem Abo-Token aus `claude setup-token` in
 * `CLAUDE_CODE_OAUTH_TOKEN`. Kein API-Key: Steht `ANTHROPIC_API_KEY` oder
 * `ANTHROPIC_AUTH_TOKEN` in der Umgebung, nähme die CLI den und rechnete pro
 * Token ab; deshalb gehen beide nicht an den Kindprozess.
 *
 * `write`: reine Textarbeit ohne Werkzeuge: `--tools ""`, `--safe-mode` (kein
 * CLAUDE.md, keine Hooks, Skills, Plugins, MCP), `--permission-mode dontAsk`,
 * leeres Arbeitsverzeichnis. Die Texte kommen über stdin, das Ergebnis als
 * JSON nach `--json-schema` (`structured_output`).
 *
 * `agent`: Claude mit Werkzeugen, aber nur denen eines MCP-Servers, den der
 * Aufrufer stellt (Einpflanzen, src/lesen/einpflanzen.js): keine eingebauten
 * Werkzeuge (`--tools ""`), nur dieser Server (`--strict-mcp-config`, die
 * Konfiguration als Datei mit 0600 im leeren Arbeitsverzeichnis, damit das
 * Token nicht in der Prozessliste steht), nur die genannten Werkzeuge
 * (`--allowedTools`, alles andere lehnt `dontAsk` ab), keine Skills und
 * Befehle, ein frischer Konfigurationsordner (`CLAUDE_CONFIG_DIR`) statt
 * Einstellungen und CLAUDE.md des Nutzers. `--safe-mode` geht hier nicht: Es
 * schaltet auch Server aus `--mcp-config` ab.
 *
 * `write` mit `tools` oder `mcp` (Recherche für Themen-Folgen und Fragen,
 * src/lesen/folgen.js, src/fragen/chat.js): wie `agent`, dazu die genannten
 * eingebauten Werkzeuge (etwa WebSearch und WebFetch) und alle Werkzeuge des
 * MCP-Servers (`mcp`: `{ name, config }`, der nur lesende Vault-Zugang aus
 * src/lesen/research-mcp.js), keine Einstellungsdateien (`--setting-sources ""`)
 * und auf Wunsch ein eigener Zeitrahmen (`timeoutMs`).
 *
 * Worklog: Die CLI läuft mit `--output-format stream-json`; jeder
 * Werkzeugaufruf geht, sobald er kommt, an `onTool(name, input)` (für
 * src/lesen/worklog.js), das Ergebnis steht in der letzten Zeile (`result`).
 */

export class WriterError extends Error {}

const LIMIT = 10 * 1024 * 1024;
// Lange Stapel brauchen Zeit; danach gilt der Lauf als hängen geblieben.
const TIMEOUT_MS = 15 * 60_000;

/**
 * `token`: Abo-Token, ohne ist der Autor aus. `command` und `spawn` für Tests.
 * `model`: Alias wie `sonnet` oder `opus`, `null` = Standard der CLI.
 */
export function createClaudeWriter({ token = process.env.CLAUDE_CODE_OAUTH_TOKEN || null, command = 'claude', model = () => null, timeoutMs = TIMEOUT_MS, run = spawn, logger = console }) {
  const currentModel = typeof model === 'function' ? model : () => model;

  function env(extra = {}) {
    const out = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token, DISABLE_UPDATES: '1', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DO_NOT_TRACK: '1', ...extra };
    delete out.ANTHROPIC_API_KEY;
    delete out.ANTHROPIC_AUTH_TOKEN;
    return out;
  }

  /**
   * `{ system, prompt, input, schema }` → Objekt nach `schema` (JSON Schema).
   * Optional `tools` (eingebaute Werkzeuge), `mcp` (`{ name, config }`: ein
   * Server wie in `mcpServers`), `timeoutMs` für diesen Lauf und `onTool`
   * (Werkzeugaufrufe, sobald sie kommen).
   */
  async function write({ system, prompt, input, schema, tools = [], mcp = null, timeoutMs: limit = timeoutMs, onTool = null }) {
    if (!tools.length && !mcp) return invoke({ input, limit, onTool, args: () => [...common({ system, prompt, schema }), '--tools', '', '--safe-mode', '--strict-mcp-config'] });
    const name = String(mcp?.name ?? 'vault');
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new WriterError(`Ungültiger Name des MCP-Servers „${name}“`);
    return invoke({
      input,
      limit,
      onTool,
      env: (cwd) => ({ CLAUDE_CONFIG_DIR: join(cwd, '.claude-config') }),
      args: (cwd) => {
        const config = join(cwd, 'mcp.json');
        if (mcp) writeFileSync(config, JSON.stringify({ mcpServers: { [name]: mcp.config } }), { mode: 0o600 });
        return [
          ...common({ system, prompt, schema }),
          '--tools', tools.join(','),
          ...(mcp ? ['--mcp-config', config] : []),
          '--strict-mcp-config',
          '--allowedTools', [...tools, ...(mcp ? [`mcp__${name}`] : [])].join(','),
          '--setting-sources', '',
          '--disable-slash-commands',
        ];
      },
    });
  }

  /**
   * `{ system, prompt, input, schema, mcp: { name, url, token }, tools }` → Objekt nach `schema`.
   * `tools`: Namen der Werkzeuge des Servers ohne Präfix, z. B. `vault_read`.
   */
  async function agent({ system, prompt, input, schema, mcp, tools, onTool = null }) {
    const name = String(mcp?.name ?? 'vault');
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new WriterError(`Ungültiger Name des MCP-Servers „${name}“`);
    return invoke({
      input,
      onTool,
      env: (cwd) => ({ CLAUDE_CONFIG_DIR: join(cwd, '.claude-config') }),
      args: (cwd) => {
        const config = join(cwd, 'mcp.json');
        writeFileSync(config, JSON.stringify({ mcpServers: { [name]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }), { mode: 0o600 });
        return [
          ...common({ system, prompt, schema }),
          '--tools', '',
          '--mcp-config', config,
          '--strict-mcp-config',
          '--allowedTools', (tools ?? []).map((t) => `mcp__${name}__${t}`).join(','),
          '--disable-slash-commands',
        ];
      },
    });
  }

  function common({ system, prompt, schema }) {
    const m = currentModel();
    return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema), '--system-prompt', system, '--permission-mode', 'dontAsk', '--no-session-persistence', ...(m ? ['--model', m] : [])];
  }

  async function invoke({ input, args: argsFor, env: envFor = () => ({}), limit = timeoutMs, onTool = null }) {
    if (!token) throw new WriterError('Kein Claude-Zugang: CLAUDE_CODE_OAUTH_TOKEN fehlt (Token aus `claude setup-token`)');
    // Leeres Verzeichnis: kein Projekt, kein CLAUDE.md in der Nähe.
    const cwd = mkdtempSync(join(tmpdir(), 'cockpit-claude-'));
    try {
      const args = argsFor(cwd);
      const { code, result, stderr } = await new Promise((resolve, reject) => {
        let child;
        try {
          child = run(command, args, { cwd, env: env(envFor(cwd)), stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          reject(err);
          return;
        }
        // Zeile für Zeile: Werkzeugaufrufe gleich melden, nur das Ergebnis behalten.
        let line = '';
        let skipping = false;
        let found = null;
        const consume = (raw) => {
          let ev;
          try {
            ev = JSON.parse(raw);
          } catch {
            return;
          }
          if (ev?.type === 'assistant') {
            for (const c of ev.message?.content ?? []) {
              if (c?.type !== 'tool_use' || !onTool) continue;
              try {
                onTool(String(c.name ?? ''), c.input ?? {});
              } catch (err) {
                logger.warn?.(`Claude: Worklog: ${err.message}`);
              }
            }
          } else if (ev && typeof ev === 'object' && (ev.type === 'result' || (!ev.type && ('structured_output' in ev || 'is_error' in ev)))) found = ev;
        };
        const errs = [];
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new WriterError(`Claude hat nach ${Math.round(limit / 60_000)} Minuten nicht geantwortet`));
        }, limit);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          const parts = chunk.split('\n');
          for (let i = 0; i < parts.length - 1; i += 1) {
            if (!skipping) consume(line + parts[i]);
            line = '';
            skipping = false;
          }
          if (skipping) return;
          line += parts.at(-1);
          // Übergroße Zeile (etwa eine lange Notiz als Werkzeugergebnis): bis zum Zeilenende überspringen.
          if (line.length > LIMIT) {
            line = '';
            skipping = true;
          }
        });
        child.stderr.on('data', (b) => errs.push(b));
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err.code === 'ENOENT' ? new WriterError(`Claude Code CLI („${command}“) ist nicht installiert`) : err);
        });
        child.on('close', (c) => {
          clearTimeout(timer);
          if (!skipping && line.trim()) consume(line);
          resolve({ code: c, result: found, stderr: Buffer.concat(errs).toString('utf8') });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      });
      if (!result) throw new WriterError(`Claude antwortet ohne JSON (Exit ${code})${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
      if (result.is_error || code !== 0) {
        const why = [result.result, ...(result.errors ?? [])].filter(Boolean).join(' ').slice(0, 300) || result.subtype || `Exit ${code}`;
        throw new WriterError(`Claude: ${why}`);
      }
      if (!result.structured_output || typeof result.structured_output !== 'object') throw new WriterError('Claude hat kein Ergebnis im verlangten Format geliefert');
      logger.info?.(`Claude: ${result.num_turns ?? '?'} Runden, ${Math.round((result.duration_ms ?? 0) / 1000)} s`);
      return result.structured_output;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  return { available: () => Boolean(token), write, agent };
}
