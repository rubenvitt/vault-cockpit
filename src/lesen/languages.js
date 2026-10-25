/**
 * Sprachen, in denen Claude Podcast und Report schreibt (Einstellungen →
 * Vorlesen → Folgen), Standard Deutsch. Der Name steht in der Auswahl und in
 * Claudes Auftrag („auf Englisch“); ElevenLabs erkennt die Sprache am Text.
 */
export const EPISODE_LANGUAGES = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch', nl: 'Niederländisch' };
export const DEFAULT_EPISODE_LANGUAGE = 'de';

/** Bekannte Sprache oder der Standard. */
export const episodeLanguage = (code) => (EPISODE_LANGUAGES[code] ? code : DEFAULT_EPISODE_LANGUAGE);
