import { describe, expect, it } from 'vitest';
import type { ToolImpl } from '../converse/turn';
import { fakeTextProvider } from '../texts/record';
import { BOOKING, CALLER, DAY, SLOT, yesJev } from './converse/chat';
import { converseFixture } from './converse/app';
import { converseTestCall, fakeConverseModel } from './index';

/**
 * A converse app's own tests (`dialogwright/testing`, converseCall.ts): one conversation with the app's
 * agent.yaml, code and gate, its model a script and its decision model the test's, as the server runs it.
 */

const NOW = new Date('2030-01-14T15:00:00Z');

describe('converseTestCall', () => {
  it('runs a conversation turn by turn: the greeting, the read-back, the yes, the closing; the app\'s code runs once', async () => {
    const { app, booked } = converseFixture(() => NOW);
    const c = converseTestCall(app, { model: fakeConverseModel(BOOKING), jev: yesJev(), callerNumber: CALLER, now: () => NOW });
    expect(await c.start()).toEqual(['Example Visits, how can I help?']);
    await c.say(`Is there a visit free on ${DAY}?`);
    expect(await c.say('The morning, for Sam Example, on this number.')).toEqual(['A visit Tuesday, January 15, 9 to 12 for Sam Example, on the number you\'re calling from, ending in 0123. Is that right?']);
    expect(booked).toEqual([]);
    expect(await c.say('yes')).toEqual(['You are booked for Tuesday morning.']);
    expect(booked).toMatchObject([{ window: SLOT, name: 'Sam Example', phone: CALLER }]);
    expect(await c.say('that is all')).toEqual(['Thanks for getting in touch. Goodbye.']);
    expect(c.ended).toBe('closing');
    expect(c.audit.filter((r) => r.type === 'gate').map((r) => `${String(r.detail.tool)} ${String(r.detail.verdict)}`)).toEqual(['availability ALLOW', 'book BLOCK', 'book ALLOW']);
    expect(c.traces.map((t) => t.turnIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it('gives the app\'s code the test\'s settings and a fake sender, each text recorded in the audit', async () => {
    const provider = fakeTextProvider();
    const { app } = converseFixture(() => NOW);
    const texting = { ...app, tools: { ...app.tools, book: async (_p: Record<string, string>, ctx: Parameters<ToolImpl>[1]) => (await ctx.texts!.send({ to: ctx.env('DESK')!, body: 'a visit booked' }), 'booked') } };
    const c = converseTestCall(texting, { model: fakeConverseModel(BOOKING), jev: yesJev(), callerNumber: CALLER, now: () => NOW, texts: provider, env: { DESK: '+15555550188' } });
    await c.start();
    await c.say(`Is there a visit free on ${DAY}?`);
    await c.say('The morning, for Sam Example, on this number.');
    await c.say('yes');
    expect(provider.sent).toMatchObject([{ to: '+15555550188', body: 'a visit booked', from: '+15555550100' }]);
    expect(c.audit.filter((r) => r.type === 'text_sent')).toHaveLength(1);
  });

  it('knows the account a caller\'s number is on file for, and no number on a chat that names none', async () => {
    const { app } = converseFixture(() => NOW);
    const c = converseTestCall(app, { model: fakeConverseModel([]), jev: yesJev(), now: () => NOW });
    await c.start();
    expect(c.state.caller).toEqual({ account: null });
  });
});
