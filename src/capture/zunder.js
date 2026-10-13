/**
 * Schmaler Client für Zunder (persönliche Aufgabenverwaltung).
 *
 * Spricht den MCP-Endpunkt von Zunder an (`POST /mcp`, JSON-RPC, zustandslos),
 * weil dessen Werkzeuge ein eingefrorener Vertrag sind. Ohne Stelle legt
 * `create_task` die Aufgabe in der Zunder-Inbox an: Das Cockpit leitet weiter,
 * statt einen zweiten Aufgaben-Eingang zu bauen.
 *
 * Gebraucht wird ein API-Token (`zt_…`) aus der Zunder-Web-UI. Ein Eingangs-Token
 * (`zi_…`) reicht nicht: Eingänge schreiben nur in ein festes Projekt, nie in die Inbox.
 */
export function createZunderClient({ url, token, fetch = globalThis.fetch, timeoutMs = 10_000 }) {
  const base = String(url).replace(/\/+$/, '');
  let nextId = 1;

  async function callTool(name, args) {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`Zunder antwortet mit HTTP ${res.status}`);
    const msg = await res.json();
    if (msg.error) throw new Error(`Zunder: ${msg.error.message ?? 'JSON-RPC-Fehler'}`);
    const result = msg.result ?? {};
    if (result.isError) {
      const text = result.structuredContent?.error?.message ?? result.content?.[0]?.text ?? 'unbekannter Fehler';
      throw new Error(`Zunder lehnt ab: ${text}`);
    }
    return result.structuredContent;
  }

  return {
    /** Web-Adresse einer Aufgabe, für Rücklinks im Vault. */
    taskUrl: (id) => `${base}/#/aufgabe/${id}`,

    /** Aufgaben nach Filtern (`filter_tasks`), für die Wochenansicht des Cockpits. */
    async filterTasks(filters) {
      const out = await callTool('filter_tasks', filters);
      return out?.tasks ?? [];
    },

    /** Eine Aufgabe (`get_task`), für Aufgaben-Knoten im Graphen. */
    async getTask(id) {
      const out = await callTool('get_task', { task_id: id });
      return out?.task ?? null;
    },

    /** Setzt den Status einer Aufgabe (`update_task`), für die Zunder-Brücke. */
    async setStatus(id, status) {
      const out = await callTool('update_task', { task_id: id, status });
      return out?.task ?? null;
    },

    /** Ändert Felder einer Aufgabe (`update_task`, z. B. `due`); null entfernt einen Wert. */
    async updateTask(id, fields) {
      const out = await callTool('update_task', { task_id: id, ...fields });
      return out?.task ?? null;
    },

    /** Legt eine Aufgabe an eine Stelle (`move_task`): `{kind: 'area'|'project'|'loose'|'inbox', id?}`. */
    async moveTask(id, location) {
      const out = await callTool('move_task', { task_id: id, location });
      return out?.task ?? null;
    },

    /** Bereiche mit ihren Projekten (`list_structure`), für „Zuordnen“. */
    async listStructure() {
      const out = await callTool('list_structure', {});
      return out?.areas ?? [];
    },

    /** Legt eine Aufgabe in der Zunder-Inbox an und liefert `{ id, ref, url }`. */
    async createTask({ title, description, vaultLinks }) {
      const args = { title: clampTitle(title) };
      if (description) args.description = description;
      if (vaultLinks?.length) args.vault_links = vaultLinks;
      const out = await callTool('create_task', args);
      const task = out?.task;
      if (!task?.id) throw new Error('Zunder hat keine Aufgabe zurückgegeben');
      return { id: task.id, ref: task.ref ?? null, url: `${base}/#/aufgabe/${task.id}` };
    },
  };
}

/** Zunder erlaubt höchstens 500 Zeichen im Titel. */
function clampTitle(title) {
  const t = String(title ?? '').trim();
  return t.length > 500 ? `${t.slice(0, 499)}…` : t;
}
