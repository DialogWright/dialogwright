import { afterLine, openJourneys } from '../journeys';
import type { ConverseState, JourneyState } from '../state';
import type { AgentBusiness } from './schema';

const money = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/**
 * The business information as plain text, for the model's prompt and the judge: who the business is, its
 * services with their prices ("$from–$to per X", or that none is given), the price caveat, what it does not do, the facts, the
 * questions callers ask with the business's answers, and its hours.
 */
export function businessText(b: AgentBusiness): string {
  const out: string[] = [`${b.business.name}: ${b.business.about}`];
  if (b.business.where) out.push(`Where: ${b.business.where}`);
  if (b.services.length > 0) {
    out.push('Services:');
    // A service with no price says so, as a model once gave the range of a neighbouring service for one.
    for (const s of b.services) out.push(`- ${s.name}: ${s.about}${s.price ? ` ${money(s.price.from)}–${money(s.price.to)} per ${s.price.per}.` : ' No price range is given for it.'}`);
  }
  out.push(`Prices: ${b.priceCaveat.en}`);
  if (b.notOffered.length > 0) out.push('Not offered:', ...b.notOffered.map((n) => `- ${n}`));
  if (b.facts.length > 0) out.push('Facts:', ...b.facts.map((f) => `- ${f}`));
  if (b.questions.length > 0) out.push('Questions callers ask, with our answers:', ...b.questions.map((x) => `- ${x.q} ${x.a}`));
  out.push(`Hours: ${b.business.hours}`);
  return out.join('\n');
}

/**
 * What the model is told for the task the call is in, after the business information: the goal (or, once the
 * task is done, what the line helps with now), its instructions, its facts and its questions with our
 * answers; at the root, the root's guidance and what the line can help with. A task set aside is named so it
 * can be offered again. Empty for a business with no journeys.
 */
export function journeyText(b: AgentBusiness, j: JourneyState, caller: ConverseState['caller']): string {
  if (b.journeys === undefined || Object.keys(b.journeys).length === 0) return '';
  const out: string[] = [];
  const spec = j.active === null ? undefined : b.journeys[j.active];
  if (spec === undefined) {
    if (b.root?.instructions !== undefined) out.push(b.root.instructions);
    out.push('What this line can help with:', ...openJourneys(b, caller).map((id) => `- ${b.journeys![id]!.when}`));
  } else {
    const finished = j.phase === 'after';
    out.push(finished ? afterLine(b, j.active!) : `What you are helping the caller with now: ${spec.goal}`);
    if (!finished && spec.instructions !== undefined) out.push(spec.instructions);
    if (spec.facts.length > 0) out.push('Facts for this:', ...spec.facts.map((f) => `- ${f}`));
    if (spec.questions.length > 0) out.push('Questions callers ask about this, with our answers:', ...spec.questions.map((x) => `- ${x.q} ${x.a}`));
  }
  const paused = j.paused === null ? undefined : b.journeys[j.paused];
  if (paused !== undefined) out.push(`Set aside earlier on this call: ${paused.when}; offer to pick it up once this is done.`);
  return out.join('\n');
}
