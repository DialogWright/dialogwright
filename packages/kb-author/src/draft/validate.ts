import { collapseWhitespace, excerptInSource, excerptProblems, type KnowledgeBase } from 'dialogwright';
import type { Draft, ProposedTopic } from './drafter';

/**
 * The checks every draft passes before it is written to kb/pending, and every edit a reviewer makes
 * before it is approved (kb:draft and kb:review run the same function). A draft that fails one is
 * reported with its reasons and never written. They are the mechanical half of review: whether the
 * answer says what its excerpt says is the person's half.
 *
 * - The section is one the source has.
 * - The excerpt is in that section word for word (whitespace aside), and holds to kb:approve's own
 *   rules for an excerpt (dialogwright's kb/excerpt.ts excerptProblems): long enough to hold the
 *   answer to (at least 4 words and 20 characters), and every number the answer says in figures is
 *   in it, compared as numbers (`$5.00` and `5`, `9:00` and `9`, `1,000` and `1000` are alike, and
 *   the excerpt's numbers written as words, `sixty` or `twenty-five`, count).
 * - The answer is not empty, is no longer than kb.yaml's maxAnswerChars, and has no braces (an
 *   answer is fixed text, never a template).
 * - The topic is a valid id; one topics.yaml does not have is a new topic, which the draft must
 *   propose with a title (it waits in kb/pending/topics.yaml until a reviewer accepts it).
 * - Its applies names facts and values kb.yaml's applies has; its dates are days of the calendar,
 *   the end not before the start.
 * - Its answer is not another passage's or draft's answer (whitespace and case aside).
 */

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
  const answer = typeof draft.answer === 'string' ? collapseWhitespace(draft.answer) : '';
  // Said as the review page's edit says it (every excerpt problem starts "its excerpt"); kb:approve's own words for it are for the file.
  if (collapseWhitespace(excerpt) === '') problems.push('its excerpt is empty: a draft quotes the words of the section that support it');
  else {
    if (section && !excerptInSource(excerpt, section.text)) problems.push(`its excerpt is not in ${where} section "${draft.section}" word for word`);
    problems.push(...excerptProblems(excerpt, answer));
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
