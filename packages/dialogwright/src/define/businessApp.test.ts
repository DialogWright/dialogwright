import { describe, expect, it } from 'vitest';
import { replyShape } from '../core/replyShape';
import { BUSINESS_TOOLS } from './businessFiles';
import { checkApp } from './check';
import { AppDefinitionError, defineApp, type AppCode } from './defineApp';
import { BUSINESS_FIXTURE_DIR, businessFixtureCode, TOOLS } from './__fixtures__/business/app';

/**
 * The code an app built from business.yaml (the old agent mode) must hold, on the fixture business (an
 * invented library), checked as the folder is read: the engine no longer builds such an app (the mode was
 * taken out), but business.yaml still loads and is checked until it is taken out with it.
 */

describe('the code an agent-mode app writes', () => {
  /** The problems defineApp finds with the fixture folder and this code. */
  const problems = (code: AppCode): string[] => {
    try {
      defineApp(BUSINESS_FIXTURE_DIR, code);
    } catch (error) {
      if (error instanceof AppDefinitionError) return error.problems.map((p) => `${p.file} ${p.path}: ${p.message}`);
      throw error;
    }
    return [];
  };
  const { placeHold: _placeHold, ...withoutPlaceHold } = TOOLS;

  it('a then naming no tool in the code is refused, at its line in business.yaml', () => {
    expect(problems({ ...businessFixtureCode, tools: withoutPlaceHold })).toEqual(['business.yaml request.then[0]: the request calls "placeHold", which is not a tool in the code']);
  });

  it('a sees naming no tool in the code is refused', () => {
    const { roomAvailability: _seen, ...rest } = TOOLS;
    expect(problems({ ...businessFixtureCode, tools: rest })).toEqual(['business.yaml booking.fields[1].sees: the field "day" sees "roomAvailability", which is not a tool in the code']);
  });

  it('a sees tool with a text() check is refused at load: its result is shown to the model only in a closed form', () => {
    const seen = TOOLS.roomAvailability!;
    const at = 'business.yaml booking.fields[1].sees: the field "day" sees "roomAvailability", whose result is shown to the agent model, but ';
    expect(problems({ ...businessFixtureCode, tools: { ...TOOLS, roomAvailability: { ...seen, check: replyShape.object({ day: replyShape.isoDate(), note: replyShape.text() }) } } }))
      .toEqual([`${at}its reply check is not a closed form: \`note\` is free text (replyShape.text())`]);
    expect(problems({ ...businessFixtureCode, tools: { ...TOOLS, roomAvailability: { ...seen, check: (v: unknown) => typeof v === 'object' } } }))
      .toEqual([`${at}its reply check is not a closed form: the reply is checked by a function written by hand, which the engine cannot read`]);
    const { check: _check, ...unchecked } = seen;
    expect(problems({ ...businessFixtureCode, tools: { ...TOOLS, roomAvailability: unchecked } })).toEqual([`${at}the tool declares no reply check`]);
  });

  it('a field free from a seen result (freeFrom) needs the list its tool\'s check names', () => {
    const seen = TOOLS.roomAvailability!;
    expect(problems({ ...businessFixtureCode, tools: { ...TOOLS, roomAvailability: { ...seen, check: replyShape.object({ day: replyShape.isoDate(), free: replyShape.list(replyShape.oneOf(['morning', 'afternoon'])) }) } } }))
      .toEqual(['business.yaml booking.fields[2].freeFrom: the field "window" is free from "roomAvailability.windows", but the reply check of "roomAvailability" names no list "windows", so the model is never shown it']);
    expect(problems({ ...businessFixtureCode, tools: { ...TOOLS, roomAvailability: { ...seen, check: replyShape.object({ day: replyShape.isoDate(), windows: replyShape.oneOf(['morning']) }) } } }))
      .toEqual(['business.yaml booking.fields[2].freeFrom: the field "window" is free from "roomAvailability.windows", but the reply check of "roomAvailability" names no list "windows", so the model is never shown it']);
  });

  it('a tool whose params are not its form\'s values is refused', () => {
    expect(problems({ ...businessFixtureCode, tools: { ...TOOLS, noteCallback: { ...TOOLS.noteCallback!, params: ['phone'] } } })).toEqual([
      'business.yaml callback.then[0]: the tool "noteCallback" lists the params [phone], but every call the callback makes carries its values, [callbackNumber]',
    ]);
  });

  it('a tool no form calls, a tool of the engine\'s name, form hooks and facts in the code are refused', () => {
    const found = problems({ ...businessFixtureCode, tools: { ...TOOLS, spare: TOOLS.noteCallback!, [BUSINESS_TOOLS.lookup]: TOOLS.noteCallback! }, forms: { request: {} }, facts: { initial: () => ({}), clone: (f) => ({ ...f }) } });
    expect(found).toEqual([
      'app.ts code.tools.spare: the tool "spare" is in the code, but no form of business.yaml calls it (a then) and no field sees it, so it can never be called',
      'app.ts code.tools.lookupAccount: "lookupAccount" is the name of a tool the engine writes for an app in agent mode (the account the number calling is on file for)',
      'app.ts code.facts: an app in agent mode does not write facts: the engine writes the facts of its accounts from business.yaml',
      'app.ts code.forms: an app in agent mode writes no form hooks: the engine writes each form\'s from business.yaml (its read-back\'s values and its then)',
    ]);
  });

  it('pnpm check finds nothing wrong with the fixture', async () => {
    expect(await checkApp(BUSINESS_FIXTURE_DIR)).toEqual([]);
  });
});
