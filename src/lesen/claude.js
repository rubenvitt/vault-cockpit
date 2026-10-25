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

  /** `{ system, prompt, input, schema }` → Objekt nach `schema` (JSON Schema). */
  async function write({ system, prompt, input, schema }) {
    return invoke({ input, args: () => [...common({ system, prompt, schema }), '--tools', '', '--safe-mode', '--strict-mcp-config'] });
  }

  /**
   * `{ system, prompt, input, schema, mcp: { name, url, token }, tools }` → Objekt nach `schema`.
   * `tools`: Namen der Werkzeuge des Servers ohne Präfix, z. B. `vault_read`.
   */
  async function agent({ system, prompt, input, schema, mcp, tools }) {
    const name = String(mcp?.name ?? 'vault');
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new WriterError(`Ungültiger Name des MCP-Servers „${name}“`);
    return invoke({
      input,
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
    return ['-p', prompt, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--system-prompt', system, '--permission-mode', 'dontAsk', '--no-session-persistence', ...(m ? ['--model', m] : [])];
  }

  async function invoke({ input, args: argsFor, env: envFor = () => ({}) }) {
    if (!token) throw new WriterError('Kein Claude-Zugang: CLAUDE_CODE_OAUTH_TOKEN fehlt (Token aus `claude setup-token`)');
    // Leeres Verzeichnis: kein Projekt, kein CLAUDE.md in der Nähe.
    const cwd = mkdtempSync(join(tmpdir(), 'cockpit-claude-'));
    try {
      const args = argsFor(cwd);
      const { code, stdout, stderr } = await new Promise((resolve, reject) => {
        let child;
        try {
          child = run(command, args, { cwd, env: env(envFor(cwd)), stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (err) {
          reject(err);
          return;
        }
        const out = [];
        const errs = [];
        let size = 0;
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new WriterError(`Claude hat nach ${Math.round(timeoutMs / 60_000)} Minuten nicht geantwortet`));
        }, timeoutMs);
        child.stdout.on('data', (b) => {
          size += b.length;
          if (size <= LIMIT) out.push(b);
        });
        child.stderr.on('data', (b) => errs.push(b));
        child.on('error', (err) => {
          clearTimeout(timer);
          reject(err.code === 'ENOENT' ? new WriterError(`Claude Code CLI („${command}“) ist nicht installiert`) : err);
        });
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve({ code: c, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errs).toString('utf8') });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      });
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        throw new WriterError(`Claude antwortet ohne JSON (Exit ${code})${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
      }
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
