#!/usr/bin/env node
/**
 * Baut die iOS-Kurzbefehle für Capture als unsignierte `.shortcut`-Dateien (XML-Plist).
 *
 *   node scripts/kurzbefehle/build.js [--url https://vault.example] [--out assets/kurzbefehle/unsigniert]
 *
 * iOS importiert nur signierte Kurzbefehle. Signiert wird auf einem Mac mit
 * `scripts/kurzbefehle/sign.sh` (ruft `shortcuts sign` auf).
 *
 * Der Token steht nicht in der Datei: Die erste Aktion ist ein leeres Textfeld mit
 * einer Import-Frage, iOS fragt beim Import danach. Die Adresse des Cockpits steht
 * fest drin (`--url`), damit beim Import nur der Token abgefragt wird.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const OBJ = '￼';

/** Stabile UUIDs, damit ein Neubau keinen Diff erzeugt. */
const uuidFor = (...parts) => {
  const h = createHash('sha256').update(parts.join('/')).digest('hex').toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};

const out = (uuid, name) => ({ Type: 'ActionOutput', OutputUUID: uuid, OutputName: name });
const named = (name) => ({ Type: 'Variable', VariableName: name });
const shortcutInput = { Type: 'ExtensionInput' };

const attachment = (value) => ({ Value: value, WFSerializationType: 'WFTextTokenAttachment' });

/** Text mit eingebetteten Variablen: Teile sind Strings oder Anhänge. */
function tokens(...parts) {
  let string = '';
  const attachmentsByRange = {};
  for (const part of parts) {
    if (typeof part === 'string') {
      string += part;
    } else {
      attachmentsByRange[`{${string.length}, 1}`] = part;
      string += OBJ;
    }
  }
  return { Value: { string, attachmentsByRange }, WFSerializationType: 'WFTextTokenString' };
}

function dictionary(entries) {
  return {
    Value: {
      WFDictionaryFieldValueItems: Object.entries(entries).map(([key, value]) => ({
        WFItemType: 0,
        WFKey: tokens(key),
        WFValue: Array.isArray(value) ? tokens(...value) : tokens(value),
      })),
    },
    WFSerializationType: 'WFDictionaryFieldValue',
  };
}

// Klassische Aktionen tragen das Präfix `is.workflow.actions.`, App Intents ihre volle ID.
const action = (id, params = {}) => ({
  WFWorkflowActionIdentifier: id.includes('.') ? id : `is.workflow.actions.${id}`,
  WFWorkflowActionParameters: params,
});

/**
 * Gemeinsamer Schluss: Variable „Text“ an /capture schicken und den Satz aus der
 * Antwort (`message`) als Mitteilung zeigen. Bewusst ohne Wenn-Abfragen: Das
 * Cockpit formuliert Erfolg und Fehler (401, 502, 503 …) selbst, weil „Inhalte von
 * URL abrufen“ den HTTP-Status nicht liefert.
 */
function send(shortcut, { tokenUuid, url, source }) {
  const res = uuidFor(shortcut, 'antwort');
  const message = uuidFor(shortcut, 'message');
  return [
    action('downloadurl', {
      UUID: res,
      WFURL: `${url}/capture`,
      WFHTTPMethod: 'POST',
      ShowHeaders: true,
      WFHTTPHeaders: dictionary({ Authorization: ['Bearer ', out(tokenUuid, 'Text')] }),
      WFHTTPBodyType: 'JSON',
      WFJSONValues: dictionary({ text: [named('Text')], source }),
    }),
    action('getvalueforkey', {
      UUID: message,
      WFGetDictionaryValueType: 'Value',
      WFDictionaryKey: 'message',
      WFInput: attachment(out(res, 'Inhalte von URL')),
    }),
    action('notification', {
      WFNotificationActionTitle: tokens('Vault Cockpit'),
      WFNotificationActionBody: tokens(out(message, 'Wörterbuchwert')),
      WFNotificationActionSound: true,
    }),
  ];
}

function tokenAction(shortcut) {
  const uuid = uuidFor(shortcut, 'token');
  return { uuid, action: action('gettext', { UUID: uuid, WFTextActionText: '' }) };
}

const importQuestion = {
  ActionIndex: 0,
  Category: 'Parameter',
  ParameterKey: 'WFTextActionText',
  Text: 'Capture-Token des Vault Cockpits',
  DefaultValue: '',
};

function workflow({ actions, types = [], input = [], hasInput = false, noInput, glyph, color }) {
  return {
    ...(noInput ? { WFWorkflowNoInputBehavior: noInput } : {}),
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowClientVersion: '2607.0.2',
    WFWorkflowIcon: { WFWorkflowIconStartColor: color, WFWorkflowIconGlyphNumber: glyph },
    WFWorkflowImportQuestions: [importQuestion],
    WFWorkflowTypes: types,
    WFWorkflowInputContentItemClasses: input,
    WFWorkflowHasShortcutInputVariables: hasInput,
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowHasOutputFallback: false,
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions,
  };
}

/** „Notiz ins Cockpit“: Text aus dem Share-Sheet oder abfragen, an /capture schicken. */
export function notizInsCockpit({ url }) {
  const name = 'notiz';
  const token = tokenAction(name);
  return workflow({
    types: ['ActionExtension'],
    input: ['WFStringContentItem', 'WFURLContentItem', 'WFRichTextContentItem'],
    hasInput: true,
    // Ohne Share-Sheet-Eingabe fragt iOS selbst nach dem Text.
    noInput: { Name: 'WFWorkflowNoInputBehaviorAskForInput', Parameters: { ItemClass: 'WFStringContentItem' } },
    glyph: 59446,
    color: 4282601983,
    actions: [
      token.action,
      action('setvariable', { WFVariableName: 'Text', WFInput: attachment(shortcutInput) }),
      ...send(name, { tokenUuid: token.uuid, url, source: 'ios-kurzbefehl' }),
    ],
  });
}

/** „Sprachmemo ins Cockpit“: aufnehmen, auf dem Gerät transkribieren, Text an /capture. */
export function sprachmemoInsCockpit({ url }) {
  const name = 'sprachmemo';
  const token = tokenAction(name);
  const record = uuidFor(name, 'aufnahme');
  const transcribe = uuidFor(name, 'transkript');
  return workflow({
    glyph: 59500,
    color: 4274264319,
    actions: [
      token.action,
      action('recordaudio', { UUID: record, WFRecordingStart: 'Immediately', WFRecordingEnd: 'On Tap' }),
      // „Audio transkribieren“ ist ein App Intent von ActionKit (geprüft auf macOS 27).
      action('com.apple.ShortcutsActions.TranscribeAudioAction', {
        UUID: transcribe,
        audioFile: attachment(out(record, 'Aufgenommenes Audio')),
      }),
      action('setvariable', { WFVariableName: 'Text', WFInput: attachment(out(transcribe, 'Transkript')) }),
      // Leeres Transkript meldet das Cockpit selbst („Text darf nicht leer sein“).
      ...send(name, { tokenUuid: token.uuid, url, source: 'sprachmemo' }),
    ],
  });
}

export const SHORTCUTS = {
  'Notiz ins Cockpit': notizInsCockpit,
  'Sprachmemo ins Cockpit': sprachmemoInsCockpit,
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function xml(value, indent) {
  const pad = '\t'.repeat(indent);
  if (typeof value === 'string') return `${pad}<string>${esc(value)}</string>`;
  if (typeof value === 'boolean') return `${pad}<${value}/>`;
  if (typeof value === 'number') return `${pad}<integer>${value}</integer>`;
  if (Array.isArray(value)) {
    if (!value.length) return `${pad}<array/>`;
    return [`${pad}<array>`, ...value.map((v) => xml(v, indent + 1)), `${pad}</array>`].join('\n');
  }
  const keys = Object.keys(value);
  if (!keys.length) return `${pad}<dict/>`;
  return [`${pad}<dict>`, ...keys.flatMap((k) => [`${pad}\t<key>${esc(k)}</key>`, xml(value[k], indent + 1)]), `${pad}</dict>`].join('\n');
}

export function toPlist(obj) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    xml(obj, 0),
    '</plist>',
    '',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      url: { type: 'string', default: 'https://vault.rubeen.dev' },
      out: { type: 'string', default: 'assets/kurzbefehle/unsigniert' },
    },
  });
  const url = values.url.replace(/\/+$/, '');
  mkdirSync(values.out, { recursive: true });
  for (const [title, build] of Object.entries(SHORTCUTS)) {
    const file = join(values.out, `${title}.shortcut`);
    writeFileSync(file, toPlist(build({ url })));
    console.log(file);
  }
}
