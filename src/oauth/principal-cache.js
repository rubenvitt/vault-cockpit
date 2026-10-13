/**
 * Kurzlebiger Zwischenspeicher für bereits geprüfte Tokens.
 *
 * Zwei Gründe: Die JWT-Prüfung ist asynchron, die MCP-Server-Factory aber
 * synchron — und ohne Cache würde bei jedem Tool-Aufruf erneut eine
 * RSA-Signatur geprüft. Die Lebensdauer eines Eintrags endet exakt mit der
 * Gültigkeit des Tokens, ein Eintrag kann ein Token also nie überleben.
 */
export function createPrincipalCache() {
  const entries = new Map();

  const abgelaufen = (p) => p.expiresAt <= Math.floor(Date.now() / 1000);

  return {
    put(token, principal) {
      entries.set(token, principal);
    },
    get(token) {
      const p = entries.get(token);
      if (!p) return null;
      if (abgelaufen(p)) {
        entries.delete(token);
        return null;
      }
      return p;
    },
    sweep() {
      for (const [token, p] of entries) if (abgelaufen(p)) entries.delete(token);
    },
    size: () => entries.size,
  };
}
