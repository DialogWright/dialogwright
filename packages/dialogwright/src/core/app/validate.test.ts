import { describe, expect, it } from 'vitest';
import { useTestkit } from '../../testing/apps';
import { registerTestkit, testkitApp } from '../../testing/testkit';
import { registerApp, resetAppsForTest } from './registry';
import type { App } from './types';
import { validateApp } from './validate';
import { formOf, slotSpecOf, toolOf } from './lookup';

useTestkit();

const copy = (): App => ({
  ...testkitApp,
  intents: { ...testkitApp.intents },
  menu: [...testkitApp.menu],
  forms: { ...testkitApp.forms },
  identity: { ...testkitApp.identity!, factorSlots: [...testkitApp.identity!.factorSlots] },
});

describe('validateApp', () => {
  it('accepts the testkit', () => {
    expect(() => validateApp(testkitApp)).not.toThrow();
  });

  it('names a form slot that is not a slot', () => {
    const app = copy();
    app.forms.track_parcel = { ...testkitApp.forms.track_parcel!, slots: ['parcelSelect', 'ghostSlot'] };
    expect(() => validateApp(app)).toThrow(/track_parcel.*ghostSlot/);
  });

  describe('where a slot listens (SlotSpec.listen) and what an unsure intent gets (unsureIntent, IntentDef.unsure)', () => {
    const listening = (id: string, listen: unknown): App => ({ ...copy(), slots: { ...testkitApp.slots, [id]: { ...testkitApp.slots[id]!, listen: listen as never } } });

    it('accepts each value on a slot of a form', () => {
      for (const listen of ['up-front', 'form', 'anywhere', 'call']) expect(() => validateApp(listening('deliveryDay', listen))).not.toThrow();
    });

    it('refuses a value it does not have', () => {
      expect(() => validateApp(listening('deliveryDay', 'anywere'))).toThrow('slot "deliveryDay" says listen: "anywere", which is not one of "up-front", "form", "anywhere", "call"');
    });

    it('refuses listen on an identity factor', () => {
      expect(() => validateApp(listening('accountId', 'form'))).toThrow('slot "accountId" is an identity factor, which listens as identity says: delete its listen');
    });

    it('refuses a carried slot that says it listens other than for the call', () => {
      expect(() => validateApp({ ...listening('deliveryDay', 'form'), carrySlots: ['deliveryDay'] })).toThrow('slot "deliveryDay" is carried (carrySlots), which is listen: call, but says listen: form');
      expect(() => validateApp({ ...listening('deliveryDay', 'call'), carrySlots: ['deliveryDay'] })).not.toThrow();
    });

    it('refuses an unsure setting it does not have, on the app or an intent', () => {
      expect(() => validateApp({ ...copy(), unsureIntent: 'no-match' })).not.toThrow();
      expect(() => validateApp({ ...copy(), unsureIntent: 'never' as never })).toThrow('unsureIntent "never" is not "confirm" or "no-match"');
      const intents = { ...testkitApp.intents, report_missing: { ...testkitApp.intents.report_missing!, unsure: 'maybe' as never } };
      expect(() => validateApp({ ...copy(), intents })).toThrow('intent "report_missing" has unsure "maybe", which is not "confirm" or "no-match"');
    });
  });

  it('names an identity factor slot that is not a slot', () => {
    const app = copy();
    app.identity!.factorSlots = ['accountId', 'ghostFactor'];
    expect(() => validateApp(app)).toThrow(/ghostFactor/);
  });

  describe('what is recorded (policy audit, ToolDef.params)', () => {
    const withAudit = (audit: Record<string, string> | undefined, tools: App['tools'] = testkitApp.tools): App => ({ ...copy(), id: 'audit-bad', tools, policy: { ...testkitApp.policy, audit: audit as never } });

    it('accepts the testkit, and an app built in code whose tools list no params', () => {
      expect(() => validateApp(withAudit(testkitApp.policy.audit))).not.toThrow();
      const bare = Object.fromEntries(Object.entries(testkitApp.tools).map(([tool, { params: _params, ...def }]) => [tool, def]));
      expect(() => validateApp(withAudit(undefined, bare))).not.toThrow();
    });

    it('a declaration that is not one of the five, a listed param no slot or declaration covers, params that are not a list', () => {
      expect(() => validateApp(withAudit({ ...testkitApp.policy.audit, parcel: 'hidden' }))).toThrow('app "audit-bad": policy records "parcel" as "hidden", which is not one of last4, mask, length, secret, keep');
      const { parcel: _parcel, ...rest } = testkitApp.policy.audit!;
      expect(() => validateApp(withAudit(rest))).toThrow('app "audit-bad": tool "getParcel" sends "parcel", which is neither a slot with a redact setting nor declared in the policy\'s audit');
      expect(() => validateApp(withAudit(testkitApp.policy.audit, { ...testkitApp.tools, getParcel: { ...testkitApp.tools.getParcel!, params: 'parcel' as never } }))).toThrow('app "audit-bad": tool "getParcel"\'s params is not a list of param names');
      expect(() => validateApp(withAudit(testkitApp.policy.audit, { ...testkitApp.tools, getParcel: { ...testkitApp.tools.getParcel!, params: ['parcel', 'parcel'] } }))).toThrow('app "audit-bad": tool "getParcel" lists a param twice');
    });
  });

  describe('console links', () => {
    const link = (id: string) => ({ id, label: 'L', title: 'T', href: '/x', target: `t-${id}`, features: '' });
    const withLinks = (...ids: string[]): App => ({ ...copy(), console: { ...testkitApp.console, links: ids.map(link) } });

    it('accepts links with their own ids', () => {
      expect(() => validateApp(withLinks('chat', 'help-page'))).not.toThrow();
    });

    it.each(['presenter', 'level', 'audit', 'now', 'handoff'])('refuses the console page\'s own element id %s', (id) => {
      expect(() => validateApp(withLinks(id))).toThrow(/console link id ".*" is an element id the console page already uses/);
    });

    it('refuses a duplicate id and an id that is not a lowercase word', () => {
      expect(() => validateApp(withLinks('chat', 'chat'))).toThrow(/used twice/);
      for (const id of ['', 'Chat', 'a b', 'x"y', '1x']) expect(() => validateApp(withLinks(id)), id).toThrow(/is not a lowercase word/);
    });
  });

  it('names a rule the gate does not know', () => {
    const app = copy();
    app.policy = { ...testkitApp.policy, rulesFor: { ...testkitApp.policy.rulesFor, getParcel: ['R1', 'R9'] } };
    expect(() => validateApp(app)).toThrow(/getParcel.*R9/);
  });

  it('names a tool with rules that is not a tool', () => {
    const app = copy();
    app.policy = { ...testkitApp.policy, rulesFor: { ...testkitApp.policy.rulesFor, ghostTool: ['R1'] } };
    expect(() => validateApp(app)).toThrow(/ghostTool.*not a tool/);
  });

  for (const role of ['verifyTool', 'codeTool', 'sendCodeTool'] as const) {
    it(`names an identity ${role} that is not a tool, or has no rules`, () => {
      const notATool = copy();
      notATool.identity = { ...notATool.identity!, [role]: 'ghostTool' };
      expect(() => validateApp(notATool)).toThrow(new RegExp(`${role} "ghostTool" is not a tool`));
      const noRules = copy();
      noRules.tools = { ...testkitApp.tools, ghostTool: testkitApp.tools.verifyCode! };
      noRules.identity = { ...noRules.identity!, [role]: 'ghostTool' };
      expect(() => validateApp(noRules)).toThrow(new RegExp(`${role} "ghostTool" has no rules`));
    });
  }

  it('names a tool with a level but no rules', () => {
    const app = copy();
    app.policy = { ...testkitApp.policy, toolLevel: { ...testkitApp.policy.toolLevel, ghostTool: 1 } };
    expect(() => validateApp(app)).toThrow(/level for tool "ghostTool"/);
  });

  it('names a tool with roles but no rules', () => {
    const app = copy();
    app.policy = { ...testkitApp.policy, roles: { ...testkitApp.policy.roles, ghostTool: { viewer: 'allow' } } };
    expect(() => validateApp(app)).toThrow(/roles for tool "ghostTool"/);
  });

  it('names a menu intent that is not an intent', () => {
    const app = copy();
    app.menu = [...app.menu, { digit: '9', intent: 'ghostIntent' }];
    expect(() => validateApp(app)).toThrow(/ghostIntent/);
  });

  it('names a form intent without a form', () => {
    const app = copy();
    app.intents.ghostForm = { criteria: 'x', label: 'x', kind: 'form' };
    expect(() => validateApp(app)).toThrow(/ghostForm/);
  });

  it('names a form without a form intent', () => {
    const app = copy();
    app.forms.orphan = testkitApp.forms.track_parcel!;
    expect(() => validateApp(app)).toThrow(/orphan/);
  });

  it('names an informational intent without a prompt', () => {
    const app = copy();
    app.intents.capabilities = { criteria: 'x', label: 'x', kind: 'informational' };
    expect(() => validateApp(app)).toThrow(/capabilities.*promptId/);
  });

  it('names a language switch the app cannot make: a locale it does not speak, on a form intent, or with a passage', () => {
    const app = copy();
    app.intents.spanish = { criteria: 'x', label: 'x', kind: 'informational', locale: 'es' };
    expect(() => validateApp(app)).toThrow(/spanish.*"es", which the app does not speak/);
    app.intents.spanish = { criteria: 'x', label: 'x', kind: 'informational', locale: 'en-US' };
    expect(() => validateApp(app)).not.toThrow();
    app.intents.track_parcel = { ...testkitApp.intents.track_parcel!, locale: 'en-US' };
    expect(() => validateApp(app)).toThrow(/track_parcel.*only an informational intent switches the language/);
  });

  it('names a voice block that names a locale the app does not speak, or a carrier the engine does not know', () => {
    expect(() => validateApp({ ...copy(), voice: { numbers: { '+15555550142': 'es' } } })).toThrow(/voice\.numbers.*"es"/);
    expect(() => validateApp({ ...copy(), voice: { locales: { es: {} } } })).toThrow(/voice\.locales.*"es"/);
    expect(() => validateApp({ ...copy(), voice: { locales: { 'en-US': { voices: { acme: 'x' } } } } })).toThrow(/unknown voice provider "acme"/);
    expect(() => validateApp({ ...copy(), voice: { locales: { 'en-US': { voices: { twilio: 'x' } } } } })).not.toThrow();
    expect(() => validateApp({ ...copy(), voice: { locales: { 'en-US': { voices: { twilio: { voice: 'x', provider: 'Google' } } } } } })).not.toThrow();
    expect(() => validateApp({ ...copy(), voice: { locales: { 'en-US': { voices: { twilio: { voice: 'x', provider: 'Gogle' } } } } } })).toThrow(/voice.locales.en-US.voices.twilio.provider "Gogle" is not one of Twilio's TTS providers \(Google, Amazon, ElevenLabs\)/);
    expect(() => validateApp({ ...copy(), voice: { locales: { 'en-US': { voices: { telnyx: { voice: 'Telnyx.Ultra.Asher', provider: 'Google' } } } } } })).toThrow(/voice.locales.en-US.voices.telnyx names a provider, which only a Twilio voice takes/);
    expect(() => validateApp({ ...copy(), voice: { locales: { 'en-US': { recognition: { acme: {} } } } } })).toThrow(/recognition names the unknown voice provider "acme"/);
    expect(() => validateApp({ ...copy(), voice: { locales: { 'en-US': { recognition: { twilio: { model: 'flux"/>' } } } } } })).toThrow(/recognition\.twilio\.model "flux"\/>" is not a recognizer name/);
    expect(() => validateApp({ ...copy(), voice: { locales: { 'en-US': { recognition: { twilio: { provider: 'Google', model: 'telephony' } } } } } })).not.toThrow();
  });

  it.each(['agent', 'repeat_prompt'])('requires the control intent %s', (id) => {
    const app = copy();
    delete app.intents[id];
    app.menu = app.menu.filter((m) => m.intent !== id);
    expect(() => validateApp(app)).toThrow(new RegExp(`control intent "${id}"`));
  });

  it('does not require the control intent done (a call may end only at a completion, a handoff or a hang-up)', () => {
    const app = copy();
    delete app.intents.done;
    app.menu = app.menu.filter((m) => m.intent !== 'done');
    expect(() => validateApp(app)).not.toThrow();
  });

  it('is applied at registration', () => {
    resetAppsForTest();
    const app = copy();
    app.identity!.factorSlots = ['ghostFactor'];
    expect(() => registerApp(app)).toThrow(/ghostFactor/);
    registerTestkit();
  });
});

describe('validateApp: the identity ladder', () => {
  const identity = testkitApp.identity!;

  it('refuses at registration a policy whose attempts are not identity.yaml\'s', () => {
    expect(identity.maxAttempts).toBe(3);
    expect(() => validateApp({ ...testkitApp, id: 'five', policy: { ...testkitApp.policy, maxAttempts: 5 } })).toThrow('app "five": policy\'s maxAttempts (5) is not identity.yaml\'s attempts (3)');
  });

  it('refuses at registration a code length outside 4 to 8', () => {
    for (const codeLength of [3, 9, 6.5]) expect(() => validateApp({ ...testkitApp, identity: { ...identity, codeLength } })).toThrow(`identity codeLength ${codeLength} is not a whole number from 4 to 8`);
  });

  it('refuses at registration level names that are blank or the same', () => {
    expect(() => validateApp({ ...testkitApp, identity: { ...identity, levelNames: { 1: ' ', 2: 'confirmed by code' } } })).toThrow('identity level 1 has no name');
    expect(() => validateApp({ ...testkitApp, identity: { ...identity, levelNames: { 1: 'verified' } } })).toThrow('identity level 2 has no name');
    expect(() => validateApp({ ...testkitApp, identity: { ...identity, levelNames: { 1: 'Verified', 2: 'verified' } } })).toThrow('identity levels 1 and 2 are both called "Verified"');
  });
});

describe('formOf, slotSpecOf and toolOf', () => {
  it('return the testkit\'s definitions', () => {
    expect(formOf(testkitApp, 'track_parcel')).toBe(testkitApp.forms.track_parcel);
    expect(slotSpecOf(testkitApp, 'accountId')).toBe(testkitApp.slots.accountId);
    expect(toolOf(testkitApp, 'getParcel')).toBe(testkitApp.tools.getParcel);
  });
  it('throw naming the id and the app', () => {
    expect(() => formOf(testkitApp, 'nope')).toThrow('unknown form "nope" in app "testkit"');
    expect(() => slotSpecOf(testkitApp, 'nope')).toThrow('unknown slot "nope" in app "testkit"');
    expect(() => formOf(testkitApp, 'toString')).toThrow(/unknown form "toString"/);
    expect(() => toolOf(testkitApp, 'nope')).toThrow('unknown tool "nope" in app "testkit"');
    expect(() => toolOf(testkitApp, 'toString')).toThrow(/unknown tool "toString"/);
  });
});
