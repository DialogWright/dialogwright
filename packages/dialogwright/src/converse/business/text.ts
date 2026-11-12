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
