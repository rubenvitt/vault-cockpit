// Einstieg für das gebündelte Graph-Paket unter `src/web/static/vendor/graph-lib.js`.
// Neu bauen mit `npm run vendor` (nur nach einem Versionswechsel nötig); das
// Ergebnis ist eingecheckt, der Server braucht zur Laufzeit keinen Build.
export { default as Graph } from 'graphology';
export { default as Sigma } from 'sigma';
export { default as forceAtlas2 } from 'graphology-layout-forceatlas2';
