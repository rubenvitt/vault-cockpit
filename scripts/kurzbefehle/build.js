#!/usr/bin/env node
/**
 * Baut die iOS-Kurzbefehle für Capture als unsignierte `.shortcut`-Dateien (XML-Plist).
 *
 *   node scripts/kurzbefehle/build.js [--url https://vault.example] [--out docs/kurzbefehle/unsigniert]
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

const action = (id, params = {}) => ({ WFWorkflowActionIdentifier: `is.workflow.actions.${id}`, WFWorkflowActionParameters: params });

/** Baut If/Otherwise/End-If-Blöcke mit gemeinsamer Gruppen-ID. */
function makeIf(shortcut) {
  let n = 0;
  return (input, condition, value, then, otherwise) => {
    const group = uuidFor(shortcut, 'if', ++n);
    const compare = value === undefined ? {} : { WFConditionalActionString: value };
    const head = action('conditional', {
      GroupingIdentifier: group,
      WFControlFlowMode: 0,
      WFCondition: condition,
      WFInput: { Type: 'Variable', Variable: attachment(input) },
      ...compare,
    });
    const blocks = [head, ...then];
    if (otherwise) blocks.push(action('conditional', { GroupingIdentifier: group, WFControlFlowMode: 1 }), ...otherwise);
    blocks.push(action('conditional', { GroupingIdentifier: group, WFControlFlowMode: 2, UUID: uuidFor(shortcut, 'endif', n) }));
    return blocks;
  };
}

// Bedingungen der Wenn-Aktion
const IS = 4;
const HAS_VALUE = 100;
const HAS_NO_VALUE = 101;

const notify = (title, ...body) =>
  action('notification', {
    WFNotificationActionTitle: tokens(title),
    WFNotificationActionBody: tokens(...body),
    WFNotificationActionSound: true,
  });

/**
 * Gemeinsamer Schluss: Variable „Text“ an /capture schicken und die Antwort als
 * Mitteilung zeigen. Fehler tragen ihren Status im Body (`{error, status}`), weil
 * „Inhalte von URL abrufen“ den HTTP-Status nicht liefert.
 */
function send(shortcut, { tokenUuid, url, source, ifBlock }) {
  const id = (label) => uuidFor(shortcut, label);
  const value = (key, from, label) =>
    action('getvalueforkey', {
      UUID: id(label),
      WFGetDictionaryValueType: 'Value',
      WFDictionaryKey: key,
      WFInput: attachment(out(from, 'Inhalte von URL')),
    });
  const res = id('antwort');
  const error = out(id('error'), 'Wörterbuchwert');
  const status = out(id('status-text'), 'Text');

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
    value('error', res, 'error'),
    ...ifBlock(
      error,
      HAS_VALUE,
      undefined,
      [
        value('status', res, 'status'),
        action('gettext', { UUID: id('status-text'), WFTextActionText: tokens(out(id('status'), 'Wörterbuchwert')) }),
        ...ifBlock(
          status,
          IS,
          '401',
          [notify('Token abgelehnt', 'Der Capture-Token stimmt nicht. Den Kurzbefehl neu importieren oder den Token in der ersten Aktion ersetzen.')],
          ifBlock(
            status,
            IS,
            '503',
            [notify('Zunder nicht angebunden', 'Aufgaben mit ! gehen erst, wenn das Cockpit mit Zunder verbunden ist. Ohne ! vorne wird es eine Notiz.')],
            ifBlock(
              status,
              IS,
              '502',
              [notify('Zunder lehnt ab', error)],
              [notify('Cockpit meldet einen Fehler', status, ': ', error)],
            ),
          ),
        ),
      ],
      [
        value('kind', res, 'kind'),
        ...ifBlock(
          out(id('kind'), 'Wörterbuchwert'),
          IS,
          'task',
          [value('ref', res, 'ref'), notify('Aufgabe angelegt', out(id('ref'), 'Wörterbuchwert'), ' liegt in der Zunder-Inbox.')],
          [value('path', res, 'path'), notify('Notiz angelegt', out(id('path'), 'Wörterbuchwert'))],
        ),
      ],
    ),
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

function workflow({ actions, types = [], input = [], hasInput = false, glyph, color }) {
  return {
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
  const ifBlock = makeIf(name);
  const token = tokenAction(name);
  const ask = uuidFor(name, 'frage');
  return workflow({
    types: ['ActionExtension'],
    input: ['WFStringContentItem', 'WFURLContentItem', 'WFRichTextContentItem'],
    hasInput: true,
    glyph: 59446,
    color: 4282601983,
    actions: [
      token.action,
      ...ifBlock(
        shortcutInput,
        HAS_VALUE,
        undefined,
        [action('setvariable', { WFVariableName: 'Text', WFInput: attachment(shortcutInput) })],
        [
          action('ask', { UUID: ask, WFAskActionPrompt: 'Was soll ins Cockpit? (! vorne = Aufgabe)', WFInputType: 'Text' }),
          action('setvariable', { WFVariableName: 'Text', WFInput: attachment(out(ask, 'Eingabe')) }),
        ],
      ),
      ...send(name, { tokenUuid: token.uuid, url, source: 'ios-kurzbefehl', ifBlock }),
    ],
  });
}

/** „Sprachmemo ins Cockpit“: aufnehmen, auf dem Gerät transkribieren, Text an /capture. */
export function sprachmemoInsCockpit({ url }) {
  const name = 'sprachmemo';
  const ifBlock = makeIf(name);
  const token = tokenAction(name);
  const record = uuidFor(name, 'aufnahme');
  const transcribe = uuidFor(name, 'transkript');
  return workflow({
    glyph: 59500,
    color: 4274264319,
    actions: [
      token.action,
      action('recordaudio', { UUID: record, WFRecordingStart: 'Immediately', WFRecordingEnd: 'On Tap' }),
      // Ohne Eingabe-Parameter nimmt die Aktion die Ausgabe der vorigen (die Aufnahme).
      action('transcribeaudio', { UUID: transcribe }),
      action('setvariable', { WFVariableName: 'Text', WFInput: attachment(out(transcribe, 'Transkript')) }),
      ...ifBlock(named('Text'), HAS_NO_VALUE, undefined, [notify('Nichts verstanden', 'Die Aufnahme ergab keinen Text.'), action('exit')]),
      ...send(name, { tokenUuid: token.uuid, url, source: 'sprachmemo', ifBlock }),
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
      out: { type: 'string', default: 'docs/kurzbefehle/unsigniert' },
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
