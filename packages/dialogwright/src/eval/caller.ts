import type { ConverseModel, ModelMessage, ModelTool } from '../converse/model/types';
import type { Budget } from './budget';
import type { CallerEnd, CallerFn, SimTurn } from './chatDriver';
import type { Persona } from './personas';

const HANG_UP: ModelTool = {
  name: 'hang_up',
  description: 'End the call: you have what you wanted, or you give up.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};

/** What the model that plays the caller is told: who they are and what is true of them, never what the business says. */
export function callerSystem(p: Persona): string {
  const truth = Object.entries(p.truth).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  return [
    'You are playing a person who has contacted a business by text chat, for a test of the business\'s automated line. Be that person: write only what they would type, one message at a time, with no stage directions and no quotation marks.',
    `What you want: ${p.goal}`,
    `What is true of you (state these when asked or when they come up; invent nothing else about yourself, and if you are asked for something not listed, say you are not sure or do not have it):\n${truth}`,
    `How you write: ${p.manner}`,
    ...(p.adversarial !== undefined ? [`What you are trying: ${p.adversarial}`] : []),
    ...(p.asksIfHuman === true ? ['At some point early on, ask whether you are talking to a real person.'] : []),
    'Never reveal or hint that you are simulated or that this is a test: you are an ordinary person.',
    'When you have what you wanted, or you would give up, say goodbye and call the hang_up tool.',
  ].join('\n\n');
}

function messagesOf(turns: readonly SimTurn[]): ModelMessage[] {
  // The line speaks to the caller (the model's user turn); the caller's own earlier messages are the model's.
  const out: ModelMessage[] = [];
  for (const t of turns) {
    const role = t.who === 'line' ? 'user' : 'assistant';
    const last = out.at(-1);
    if (last !== undefined && last.role === role) last.content.push({ type: 'text', text: t.text });
    else out.push({ role, content: [{ type: 'text', text: t.text }] });
  }
  if (out.length === 0) out.push({ role: 'user', content: [{ type: 'text', text: '(the line is waiting for you to speak first)' }] });
  return out;
}

/**
 * A caller played by a model; its tokens are added to the budget. A model's failure is thrown. It ends the call as
 * `hang_up` (its goodbye, if it said one, is kept and not sent) or as `empty`: a reply with no text and no hang_up
 * is asked for again once (the same request), and only a second empty one ends the call. Both requests are spent.
 */
export function modelCaller(model: ConverseModel, spend: Budget): CallerFn {
  const ask = async (persona: Persona, turns: readonly SimTurn[]): Promise<{ said: string; hungUp: boolean }> => {
    let text = '';
    let hungUp = false;
    for await (const ev of model.stream({ system: callerSystem(persona), messages: messagesOf(turns), tools: [HANG_UP], maxTokens: 300 }, AbortSignal.timeout(30_000))) {
      if (ev.type === 'text') text += ev.delta;
      else if (ev.type === 'tool_call' && ev.name === HANG_UP.name) hungUp = true;
      else if (ev.type === 'done') spend.add(model.id, ev.usage);
      else if (ev.type === 'error') throw new Error(`the caller model failed (${ev.kind}): ${ev.detail}`);
    }
    return { said: text.trim(), hungUp };
  };
  return async (persona, turns) => {
    let r = await ask(persona, turns);
    if (!r.hungUp && r.said === '') r = await ask(persona, turns);
    // A goodbye said with the hang-up is not sent: the call ends there, and the goodbye is kept.
    if (r.hungUp) return { how: 'hang_up', ...(r.said !== '' ? { goodbye: r.said } : {}) };
    return r.said === '' ? { how: 'empty' } : r.said;
  };
}
