import { localDateIso } from '../core/localDate';
import type { ActionSpec, AgentBusiness, ParamSpec } from './business/schema';
import { businessText } from './business/text';
import type { ModelTool } from './model/types';
import { businessZone, type ConverseState } from './state';

/**
 * What the agent model is told (docs/designs/2026-11-11-agent-runtime.md, "The conversation loop" and
 * "Claims"): the business's information, its persona's style, agent mode's two rules (claim only what the
 * information or a lookup on this call supports; nothing changes without the caller's yes), the honesty
 * rule, the date and time in the business's zone, and what is known of the caller (the account, and the
 * number by its last four only). It gives context and goals, never a procedure for the words.
 */

/** The last four digits of a number, the only part of it the model is sent. */
const lastFour = (n: string): string => n.replace(/\D/g, '').slice(-4);

/** The date and time as a person there would say them, in the business's zone. */
function nowWords(now: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone, timeZoneName: 'short' }).format(now);
}

function callerWords(s: ConverseState): string {
  const parts: string[] = [];
  if (s.caller.account) parts.push(`The number they are calling from is on file for the account "${s.caller.account}" (a number on file recognises an account; it does not prove who is speaking).`);
  if (s.caller.number && lastFour(s.caller.number).length === 4) parts.push(`They are calling from a number ending in ${lastFour(s.caller.number)}; only the business's actions see the whole number.`);
  else if (s.channel === 'voice') parts.push('Their number is not known.');
  if (parts.length === 0) parts.push('Nothing is known about them yet.');
  return parts.join(' ');
}

export function systemPrompt(b: AgentBusiness, s: ConverseState, now: Date): string {
  const zone = businessZone(b);
  const where = s.channel === 'voice' ? `the phone line of ${b.business.name}: everything you write is spoken aloud to the caller, as it is written` : `the web chat of ${b.business.name}`;
  const person = b.transfer ? 'a person at the business can take the call over' : 'a person at the business can call them back';
  return [
    `You are the automated assistant answering ${where}. You speak for the business, in this style: ${b.persona.style} The style shapes how you sound, never what you claim.`,
    '',
    'The business information (the business\'s own words, and the only source of what you say about the business):',
    businessText(b),
    '',
    'Two rules hold on every call:',
    `1. Claim nothing that the business information or a lookup made on this call does not support. Prices, services, hours and policies come only from the business information, and any price is given with the business's caveat: "${b.priceCaveat.en}" Times and availability come only from lookups made on this call.`,
    '2. Nothing changes without the caller\'s yes. When you call an action that changes something, the line itself reads its details back to the caller in fixed words and runs it only after their yes, so you never read one back yourself. If the caller does not confirm, you are told what they said.',
    '',
    `Honesty: you are an automated assistant for ${b.business.name}, not a person, and you never pretend to be one. Asked whether you are a real person, you say you are an automated assistant and that ${person}.`,
    '',
    `Now: ${nowWords(now, zone)} (today is ${localDateIso(now.getTime(), zone)}, in the business's time zone, ${zone}).`,
    `The caller: ${callerWords(s)}`,
  ].join('\n');
}

/** How a param's value is to be written, beside its own description. */
function paramSchema(p: ParamSpec): Record<string, unknown> {
  switch (p.type) {
    case 'date': return { type: 'string', description: `${p.about} A date, written YYYY-MM-DD.` };
    case 'slot': return { type: 'string', description: `${p.about} The id of one of the results ${p.from} returned on this call.` };
    case 'choice': return { type: 'string', enum: [...(p.options ?? [])], description: p.about };
    case 'number': return { type: 'string', description: `${p.about} A number.` };
    case 'phone': return { type: 'string', description: `${p.about} A phone number with its area code.` };
    case 'text': return { type: 'string', description: p.about };
  }
}

function toolOf(name: string, spec: ActionSpec): ModelTool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [pname, p] of Object.entries(spec.params)) {
    properties[pname] = paramSchema(p);
    if (p.optional !== true) required.push(pname);
  }
  const about = spec.kind === 'change' ? `${spec.about} It changes something: the caller hears its details read back and it runs only after their yes.` : spec.about;
  return { name, description: about, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

/** The business's actions as the model's tools, each with its params' JSON Schema. */
export function toolsOf(b: AgentBusiness): ModelTool[] {
  return Object.entries(b.actions).map(([name, spec]) => toolOf(name, spec));
}
