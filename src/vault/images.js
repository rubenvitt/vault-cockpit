/** Bildformate, die die Vorschau zeigt. SVG fehlt bewusst: es kann Script enthalten. */
export const IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

export const extOf = (p) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();

/** Ein Bild, das der Index in der Tabelle `images` führt? */
export const isImagePath = (p) => Boolean(IMAGE_TYPES[extOf(String(p ?? ''))]);
