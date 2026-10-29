import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

/**
 * Einzelne Knoten, die weit draußen treiben (meist Notizen ohne Links),
 * an den Rand der Masse holen: Sonst passt der Browser den Ausschnitt an
 * sie an und der eigentliche Graph wird ein kleiner Fleck in der Mitte.
 */
function pullStragglers(graph) {
  if (graph.order < 20) return;
  const pts = [];
  graph.forEachNode((id, a) => pts.push([id, a.x, a.y]));
  const median = (vals) => vals.sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  const cx = median(pts.map((p) => p[1]));
  const cy = median(pts.map((p) => p[2]));
  const dist = pts.map(([, x, y]) => Math.hypot(x - cx, y - cy));
  const limit = [...dist].sort((a, b) => a - b)[Math.floor(dist.length * 0.98)] * 1.1;
  if (!(limit > 0)) return;
  pts.forEach(([id, x, y], i) => {
    if (dist[i] <= limit) return;
    const f = limit / dist[i];
    graph.mergeNodeAttributes(id, { x: cx + (x - cx) * f, y: cy + (y - cy) * f });
  });
}

/**
 * Layout des ganzen Vaults mit ForceAtlas2, ohne Bezug auf den Index: Knoten
 * sind Zahlen `0 … count-1`, `edges` ist flach (`[a, b, a, b, …]`), `start`
 * hat je Knoten `[x, y]` aus dem letzten Lauf oder `null`.
 *
 * Neue Knoten ohne Startpunkt landen neben einem Nachbarn, der schon einen
 * hat, sonst auf einer Spirale (deterministisch, damit Tests und Neustarts
 * dasselbe Bild liefern). Mit Startpunkten genügen wenige Durchläufe: Das
 * Bild bleibt vertraut, nur Neues sucht sich seinen Platz.
 *
 * Liefert die Positionen flach (`[x0, y0, x1, y1, …]`, auf zwei Stellen gerundet).
 */
export function computeLayout({ count, edges, start = [], iterations = null }) {
  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  for (let i = 0; i < count; i += 1) graph.addNode(i);
  for (let k = 0; k + 1 < edges.length; k += 2) {
    const a = edges[k];
    const b = edges[k + 1];
    if (a !== b && a < count && b < count && !graph.hasEdge(a, b)) graph.addEdge(a, b);
  }

  const known = start.filter(Boolean).length;
  // Spirale (Phyllotaxis) im Maßstab der vorhandenen Punkte bzw. der Knotenzahl.
  const spread = 10 * Math.sqrt(Math.max(count, 1));
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spiral = (i) => {
    const r = spread * Math.sqrt((i + 0.5) / Math.max(count, 1));
    return [Math.cos(i * golden) * r, Math.sin(i * golden) * r];
  };
  const placed = new Array(count);
  for (let i = 0; i < count; i += 1) if (start[i]) placed[i] = start[i];
  for (let i = 0; i < count; i += 1) {
    if (placed[i]) continue;
    const anchor = graph.neighbors(i).map(Number).find((n) => start[n]);
    if (anchor !== undefined) {
      const [x, y] = start[anchor];
      const a = i * golden;
      placed[i] = [x + Math.cos(a) * 2, y + Math.sin(a) * 2];
    } else placed[i] = spiral(i);
  }
  graph.forEachNode((id) => {
    const [x, y] = placed[Number(id)];
    graph.mergeNodeAttributes(id, { x, y, size: 1 });
  });

  if (count > 1) {
    const warm = known > 0 && known >= count * 0.8;
    const rounds = iterations ?? (warm ? 80 : count > 1000 ? 300 : 500);
    const settings = { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: count > 500 };
    forceAtlas2.assign(graph, { iterations: rounds, settings });
  }

  pullStragglers(graph);

  const out = new Array(count * 2);
  graph.forEachNode((id, a) => {
    const i = Number(id);
    out[2 * i] = Math.round(a.x * 100) / 100;
    out[2 * i + 1] = Math.round(a.y * 100) / 100;
  });
  return out;
}
