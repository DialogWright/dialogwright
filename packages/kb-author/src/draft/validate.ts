import { collapseWhitespace, excerptInSource, type KnowledgeBase } from 'dialogwright';
import type { Draft, ProposedTopic } from './drafter';

/**
 * The checks every draft passes before it is written to kb/pending, and every edit a reviewer makes
 * before it is approved (kb:draft and kb:review run the same function). A draft that fails one is
 * reported with its reasons and never written. They are the mechanical half of review: whether the
 * answer says what its excerpt says is the person's half.
 *
 * - The section is one the source has.
 * - The excerpt is in that section word for word (whitespace aside), and is long enough to hold the
 *   answer to: at least 4 words and 20 characters.
 * - Every number in the answer (an amount, a time, a date, a count written in figures) is in the
 *   excerpt, compared as numbers: `$5.00` and `5`, `9:00` and `9`, `1,000` and `1000` are alike, and
 *   the excerpt's numbers written as words (`sixty`, `twenty-five`) count.
 * - The answer is not empty, is no longer than kb.yaml's maxAnswerChars, and has no braces (an
 *   answer is fixed text, never a template).
 * - The topic is a valid id; one topics.yaml does not have is a new topic, which the draft must
 *   propose with a title (it waits in kb/pending/topics.yaml until a reviewer accepts it).
 * - Its applies names facts and values kb.yaml's applies has; its dates are days of the calendar,
 *   the end not before the start.
 * - Its answer is not another passage's or draft's answer (whitespace and case aside).
 */

/** The least an excerpt quotes: enough words to hold an answer to. */
export const MIN_EXCERPT_WORDS = 4;
export const MIN_EXCERPT_CHARS = 20;

const UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** A number in figures as it is written: digits, with separators between them (`1,000`, `5.00`, `9:30`, `2026-01-05`). */
const NUMBER = /\d(?:[\d,.:/-]*\d)?/g;

/** A number written in figures, as it is compared: `5.00` is `5`, `1,000` is `1000`, `9:00` is `9`, `07` is `7`. */
function normalNumber(token: string): string[] {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(token)) token = token.replace(/,/g, '');
  if (token.includes(',')) return token.split(',').flatMap(normalNumber);
  const time = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (time) return time[2] === '00' ? [String(Number(time[1]))] : [`${Number(time[1])}:${time[2]}`];
  if (token.includes(':')) return token.split(':').flatMap(normalNumber);
  if (/[-/]/.test(token)) return token.split(/[-/]/).flatMap(normalNumber);
  if (/^\d+(\.\d+)?$/.test(token)) return [String(Number(token))];
  return token.split('.').filter((t) => t !== '').map((t) => String(Number(t)));
}

/** The numbers written in figures in a text, compared as numbers (see normalNumber). */
export function figuresIn(text: string): string[] {
  return [...text.matchAll(NUMBER)].flatMap((m) => normalNumber(m[0]));
}

/** The numbers a text says: in figures, and the whole numbers up to ninety-nine written as words. */
export function numbersIn(text: string): Set<string> {
  const out = new Set(figuresIn(text));
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z]+/g) ?? []) {
    const unit = UNITS.indexOf(w);
    if (unit >= 0) out.add(String(unit));
    const ten = TENS.indexOf(w);
    if (ten >= 2) out.add(String(ten * 10));
  }
  for (const m of lower.matchAll(/\b([a-z]+)(?=[-\s]+([a-z]+)\b)/g)) {
    const ten = TENS.indexOf(m[1]!);
    const unit = UNITS.indexOf(m[2]!);
    if (ten >= 2 && unit >= 1 && unit <= 9) out.add(String(ten * 10 + unit));
  }
  return out;
}

/** The numbers an answer says in figures that its excerpt does not say, as the answer writes them. */
export function numbersNotInExcerpt(answer: string, excerpt: string): string[] {
  const quoted = numbersIn(excerpt);
  const missing: string[] = [];
  for (const m of answer.matchAll(NUMBER)) {
    if (normalNumber(m[0]).some((n) => !quoted.has(n)) && !missing.includes(m[0])) missing.push(m[0]);
  }
  return missing;
}

/** A list said in words: "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** A topic id, as topics.yaml keys it. */
export const TOPIC_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** What a draft is checked against. */
export interface DraftContext {
  kb: KnowledgeBase;
  /** The source document's id, as the messages name it. */
  document: string;
  /** Topics proposed and not yet accepted (kb/pending/topics.yaml, and earlier drafts of this run), by id. */
  proposed: Readonly<Record<string, ProposedTopic>>;
  /** The answers of the drafts waiting in kb/pending (and written this run), whitespace collapsed and lowercased, to the draft's id. */
  pendingAnswers: ReadonlyMap<string, string>;
  /** The kb folder's name, as the messages say it ("kb"). */
  base?: string;
  /** The id of the draft being checked, when it is one already in kb/pending (an edit): it does not repeat itself. */
  self?: string;
}

/** An answer as it is compared for repeats. */
export const answerKey = (answer: string): string => collapseWhitespace(answer).toLowerCase();

const isDay = (value: string): boolean => {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

/** The topic id a draft answers. */
export const topicIdOf = (draft: Pick<Draft, 'topic'>): string => (typeof draft.topic === 'string' ? draft.topic : draft.topic.id);

/** Why the draft cannot be written (or approved, for an edit): one reason a line; empty when it passes. */
export function draftProblems(draft: Draft, ctx: DraftContext): string[] {
  const problems: string[] = [];
  const base = ctx.base ?? 'kb';
  const where = `${base}/sources/${ctx.document}.yaml`;
  const kb = ctx.kb;
  const source = Object.hasOwn(kb.sources, ctx.document) ? kb.sources[ctx.document]! : undefined;

  // The source section and the excerpt.
  const section = source && Object.hasOwn(source.sections, draft.section) ? source.sections[draft.section]! : undefined;
  if (!source) problems.push(`its source document "${ctx.document}" is not in ${base}/sources`);
  else if (!section) problems.push(`section "${draft.section}" is not a section of ${where}`);
  const excerpt = typeof draft.excerpt === 'string' ? draft.excerpt : '';
  const quoted = collapseWhitespace(excerpt);
  const answer = typeof draft.answer === 'string' ? collapseWhitespace(draft.answer) : '';
  if (quoted === '') problems.push('its excerpt is empty: a draft quotes the words of the section that support it');
  else {
    if (section && !excerptInSource(excerpt, section.text)) problems.push(`its excerpt is not in ${where} section "${draft.section}" word for word`);
    if (quoted.split(' ').length < MIN_EXCERPT_WORDS || quoted.length < MIN_EXCERPT_CHARS) {
      problems.push(`its excerpt "${quoted}" is too short to hold the answer to: quote at least ${MIN_EXCERPT_WORDS} words and ${MIN_EXCERPT_CHARS} characters of the section`);
    }
    const missing = answer === '' ? [] : numbersNotInExcerpt(answer, quoted);
    if (missing.length > 0) problems.push(`its excerpt does not say ${listed(missing)}, which its answer does: every number, amount and date in the answer must be in the excerpt it quotes`);
  }

  // The answer.
  const max = kb.settings.maxAnswerChars;
  if (answer === '') problems.push('its answer is empty');
  else {
    if (answer.length > max) problems.push(`its answer is ${answer.length} characters, over the ${max} kb.yaml allows (maxAnswerChars): a spoken answer is one or two short sentences`);
    if (/[{}]/.test(answer)) problems.push('its answer has a brace: an answer is fixed text, said word for word, with no variables');
  }

  // The topic.
  const topicId = topicIdOf(draft);
  if (!TOPIC_ID.test(topicId)) problems.push(`its topic "${topicId}" is not a topic id: letters, digits and underscores, starting with a letter`);
  else if (!Object.hasOwn(kb.topics, topicId)) {
    const proposal = typeof draft.topic === 'string' ? (Object.hasOwn(ctx.proposed, topicId) ? ctx.proposed[topicId] : undefined) : draft.topic;
    if (!proposal) problems.push(`its topic "${topicId}" is not in ${base}/topics.yaml, and it proposes no title for a new one`);
    else if (typeof proposal.title !== 'string' || collapseWhitespace(proposal.title) === '') problems.push(`it proposes the topic "${topicId}" without a title`);
  }

  // Who it answers, and when.
  const domain = kb.settings.applies;
  for (const [fact, value] of Object.entries(draft.applies ?? {})) {
    if (!Object.hasOwn(domain, fact)) {
      problems.push(`its applies names "${fact}", which is not a fact of kb.yaml's applies${Object.keys(domain).length > 0 ? ` (${Object.keys(domain).join(', ')})` : ' (it has none)'}`);
      continue;
    }
    for (const v of typeof value === 'string' ? [value] : value) {
      if (!domain[fact]!.includes(v)) problems.push(`its applies gives ${fact} "${v}", which kb.yaml's applies does not list for ${fact} (${domain[fact]!.join(', ')})`);
    }
  }
  if (draft.effective) {
    const { from, to } = draft.effective;
    if (typeof from !== 'string' || !isDay(from)) problems.push(`its effective.from "${String(from)}" is not a day in the form YYYY-MM-DD`);
    if (to !== undefined && (typeof to !== 'string' || !isDay(to))) problems.push(`its effective.to "${String(to)}" is not a day in the form YYYY-MM-DD`);
    else if (to !== undefined && typeof from === 'string' && to < from) problems.push(`its effective.to (${to}) is before its effective.from (${from})`);
  }

  // Not a repeat.
  if (answer !== '') {
    const key = answerKey(answer);
    const passage = Object.values(kb.passages).find((p) => answerKey(p.answer) === key);
    if (passage) problems.push(`it repeats the answer of the passage "${passage.id}"`);
    else {
      const other = ctx.pendingAnswers.get(key);
      if (other !== undefined && other !== ctx.self) problems.push(`it repeats the answer of the draft "${other}" in ${base}/pending`);
    }
  }
  return problems;
}
