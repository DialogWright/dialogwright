import type { AgentBusiness } from './schema';

const money = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;

/**
 * The business information as plain text, for the model's prompt and the judge: who the business is, its
 * services with their prices ("$from–$to per X"), the price caveat, what it does not do, the facts, and
 * its hours.
 */
export function businessText(b: AgentBusiness): string {
  const out: string[] = [`${b.business.name}: ${b.business.about}`];
  if (b.business.where) out.push(`Where: ${b.business.where}`);
  if (b.services.length > 0) {
    out.push('Services:');
    for (const s of b.services) out.push(`- ${s.name}: ${s.about}${s.price ? ` ${money(s.price.from)}–${money(s.price.to)} per ${s.price.per}.` : ''}`);
  }
  out.push(`Prices: ${b.priceCaveat.en}`);
  if (b.notOffered.length > 0) out.push('Not offered:', ...b.notOffered.map((n) => `- ${n}`));
  if (b.facts.length > 0) out.push('Facts:', ...b.facts.map((f) => `- ${f}`));
  out.push(`Hours: ${b.business.hours}`);
  return out.join('\n');
}
