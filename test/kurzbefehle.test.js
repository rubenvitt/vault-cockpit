import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUTS, toPlist } from '../scripts/kurzbefehle/build.js';

const url = 'https://vault.test';

/** Alle Werte eines Objektbaums, die ein Feld `key` haben. */
function collect(node, key, found = []) {
  if (Array.isArray(node)) node.forEach((n) => collect(n, key, found));
  else if (node && typeof node === 'object') {
    if (key in node) found.push(node);
    Object.values(node).forEach((n) => collect(n, key, found));
  }
  return found;
}

for (const [title, build] of Object.entries(SHORTCUTS)) {
  test(`${title}: fragt beim Import nur den Token ab`, () => {
    const wf = build({ url });
    assert.equal(wf.WFWorkflowImportQuestions.length, 1);
    const [q] = wf.WFWorkflowImportQuestions;
    const target = wf.WFWorkflowActions[q.ActionIndex];
    assert.equal(target.WFWorkflowActionIdentifier, 'is.workflow.actions.gettext');
    assert.equal(target.WFWorkflowActionParameters[q.ParameterKey], '', 'kein Token in der Datei');
  });

  test(`${title}: schickt an /capture mit Bearer-Token`, () => {
    const actions = build({ url }).WFWorkflowActions;
    const post = actions.find((a) => a.WFWorkflowActionIdentifier === 'is.workflow.actions.downloadurl').WFWorkflowActionParameters;
    assert.equal(post.WFURL, `${url}/capture`);
    assert.equal(post.WFHTTPMethod, 'POST');
    const [auth] = post.WFHTTPHeaders.Value.WFDictionaryFieldValueItems;
    assert.equal(auth.WFKey.Value.string, 'Authorization');
    assert.match(auth.WFValue.Value.string, /^Bearer ￼$/);
  });

  test(`${title}: Verweise und Wenn-Blöcke sind vollständig`, () => {
    const actions = build({ url }).WFWorkflowActions;
    const seen = new Set();
    for (const a of actions) {
      for (const ref of collect(a.WFWorkflowActionParameters, 'OutputUUID')) {
        assert.ok(seen.has(ref.OutputUUID), `${ref.OutputName} verweist auf eine spätere oder fehlende Aktion`);
      }
      if (a.WFWorkflowActionParameters.UUID) seen.add(a.WFWorkflowActionParameters.UUID);
    }
    const modes = {};
    for (const a of actions.filter((x) => x.WFWorkflowActionIdentifier === 'is.workflow.actions.conditional')) {
      const p = a.WFWorkflowActionParameters;
      (modes[p.GroupingIdentifier] ??= []).push(p.WFControlFlowMode);
    }
    for (const m of Object.values(modes)) assert.ok(m[0] === 0 && m.at(-1) === 2, `Wenn-Block ${m} unvollständig`);
  });

  test(`${title}: Plist ist stabil und gültiges XML`, () => {
    const a = toPlist(build({ url }));
    assert.equal(a, toPlist(build({ url })));
    assert.match(a, /^<\?xml[\s\S]*<\/plist>\n$/);
    assert.doesNotMatch(a, /&(?!amp;|lt;|gt;)/);
  });
}

test('Sprachmemo ins Cockpit: transkribiert die Aufnahme mit dem App Intent', () => {
  const actions = SHORTCUTS['Sprachmemo ins Cockpit']({ url }).WFWorkflowActions;
  const ids = actions.map((a) => a.WFWorkflowActionIdentifier);
  const i = ids.indexOf('com.apple.ShortcutsActions.TranscribeAudioAction');
  assert.ok(i > 0, 'Transkription fehlt');
  const rec = actions[ids.indexOf('is.workflow.actions.recordaudio')].WFWorkflowActionParameters.UUID;
  assert.equal(actions[i].WFWorkflowActionParameters.audioFile.Value.OutputUUID, rec);
});
