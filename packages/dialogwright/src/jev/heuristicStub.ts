import { AMOUNT_WORDS, comparedToCaller, DATE_WORDS, hasPronounFor, isFigureWord, isSecondPerson, leftOut, personBroken, straight, toCaller } from '../render/checks';
import { choiceAnswer, choiceLabels, noulAnswer, normalize, scoreAnswer, sharp } from './distributions';
import { quietAnswer } from './defaults';
import { estimateTokens, type Answer, type AnswerMap, type JevClient, type JevRequest, type JevResponse, type Question } from './types';
import { defaultAppOrNull } from '../core/app/registry';
import type { App } from '../core/app/types';

/** The control intents' keywords: said the same way in any app. The app's own come first (App.testing.heuristics.intents). */
const CONTROL_INTENT_KEYWORDS: Array<[string, RegExp]> = [
  ['done', /\b(no thanks|that's all|that is all|nothing else|goodbye|bye|that's it)\b/],
  ['agent', /\b(agent|representative|person|human|operator|someone|somebody)\b/],
  ['repeat_prompt', /\b(repeat|say that again|what were the options|didn't hear)\b/],
  ['capabilities', /\b(what (can|do) you do|what are you|what (are|is) my options|what can i (do|say|ask)|what is this|what does this do|what else can you do)\b/],
];

const NUMBER_WORD_DIGIT: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5' };

function textOf(state: unknown): string {
  const s = state as { asr?: { text?: string } } | null;
  return (s?.asr?.text ?? '').toLowerCase();
}

/** Words a generated line may add to its fixed text and goal without saying anything of its own. */
const FILLER: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'so', 'of', 'to', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'about', 'is', 'are', 'was', 'be', 'it', "it's",
  'its', 'that', "that's", 'this', 'i', "i'm", "i'll", 'me', 'my', 'you', "you're", 'your', 'we', "we'll", 'our', 'us', 'thanks', 'thank', 'got', 'sure',
  'okay', 'ok', 'let', "let's", 'ask', 'again', 'sorry', 'please', 'understand', 'just', 'now', 'yes', 'no', 'right', 'all', 'here', 'there', 'can',
  'will', 'would', 'could', 'shall', 'do', 'does', 'what', "what's", 'which', 'who', 'how', 'when', 'where', 'if', 'then', 'also', 'more', 'happy',
  'help', 'noted', 'alright', 'great', 'of', 'course', 'certainly', 'quick', 'quickly', 'once', 'that', 'too', 'very', 'kindly', 'mind',
]);
/** A sentence that says the caller's words are the caller's: "your message says", "you said". */
const ATTRIBUTED = /\b(your message|your note|you said|you mentioned|you told|you asked|you'd like|you want|you say|says|said)\b/i;

const tokens = (text: string): string[] => straight(text).toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * What a summary must not leave out of the quoted words (the span drift question's criteria): a time or
 * an amount (a date word, an amount word, a digit) and who is to act (a name: a capitalized word that
 * does not begin a sentence, "I" aside), lower-cased.
 */
function mustKeep(quoted: string): string[] {
  const text = straight(quoted);
  const named: string[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}']+/gu)) {
    const w = m[0];
    if (!/^\p{Lu}/u.test(w)) continue;
    // A capital that begins a sentence is no name (as the checks read capitals).
    const before = text.slice(0, m.index).trimEnd();
    if (before === '' || /[.!?:;\u2014\u2013"\u201c(]$/.test(before)) continue;
    const lower = w.toLowerCase();
    if (lower !== 'i' && !lower.startsWith("i'")) named.push(lower);
  }
  return [...new Set([...tokens(quoted).filter((w) => DATE_WORDS.has(w) || AMOUNT_WORDS.has(w) || /\d/.test(w)), ...named])];
}

/**
 * The stub's drift judge (render/checks.ts renderDriftQuestion), deterministic, holding a line to the
 * question's own criteria by its words: a sentence that states something found only in the caller's
 * quoted words (a figure, a name, or three words or more of them) without attributing it to the caller;
 * a sentence with two words or more traceable to neither its fixed text, its goal nor the quoted words;
 * or words of an injection. A real model is asked the question itself.
 */
export function stubDrift(state: unknown): boolean {
  const s = state as { line?: { said?: unknown; fixed?: unknown; goal?: unknown }; quoted?: { words?: unknown }[] } | null;
  const said = typeof s?.line?.said === 'string' ? s.line.said : '';
  const fixed = typeof s?.line?.fixed === 'string' ? s.line.fixed.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, ' ') : '';
  const goal = typeof s?.line?.goal === 'string' ? s.line.goal : '';
  const known = new Set(tokens(`${fixed} ${goal}`));
  const quoted = new Set((s?.quoted ?? []).flatMap((q) => (typeof q.words === 'string' ? tokens(q.words) : [])));
  const added = tokens(said).filter((w) => !known.has(w)).join(' ');
  if (manipulationPattern(undefined).test(added) || DRIFT_CUES.test(added)) return true;
  for (const sentence of said.split(/(?<=[.!?])\s+/)) {
    const words = tokens(sentence);
    const capitalized = new Set((sentence.match(/(?<!^)\b\p{Lu}[\p{L}']*/gu) ?? []).map((w) => w.toLowerCase()));
    const quotedOnly = words.filter((w) => quoted.has(w) && !known.has(w) && !FILLER.has(w));
    const claims = quotedOnly.filter((w) => isFigureWord(w) || capitalized.has(w));
    if ((claims.length > 0 || quotedOnly.length >= 3) && !ATTRIBUTED.test(sentence)) return true;
    const novel = words.filter((w) => !known.has(w) && !quoted.has(w) && !FILLER.has(w));
    if (novel.length >= 2) return true;
  }
  return false;
}

/** First- and second-person words: a summary that uses one its quoted words do not speaks as the agent or to the listener. */
const PERSON = new Set(['i', "i'm", "i'll", "i've", "i'd", 'me', 'my', 'mine', 'we', "we're", "we'll", "we've", 'us', 'our', 'ours', 'you', "you're", "you'll", "you've", "you'd", 'your', 'yours']);

/**
 * The stub's span drift judge (render/checks.ts renderSpanDriftQuestion), deterministic, holding a
 * framed line's span to the question's criteria by its words: a span is a faithful summary of the
 * quoted words when every word of it of its own (not filler, not in its goal) is in them, it speaks in
 * no person they do not, states no figure or name they do not, leaves out none of their clauses that
 * says "no" or sets a condition (leftOut) and none of their times, amounts and names (mustKeep), and
 * carries no words of an injection. A span that speaks to the caller (`span.speaks: to-caller`) is held
 * to the quoted words turned toward the caller, and may say a name of the line (`frame`) that they do not
 * only in place of a pronoun the stub can tell is that one: the quoted words have a third-person pronoun
 * or a "you" and name no one of their own (the names are only those the span lists, who the message is
 * for; never the caller's), and the persons are held as the checks hold them (personBroken: whose words,
 * and who does what to whom). "tell Riley I need him to call the printer" summarized with the
 * recipient's name is unfaithful. A real model is asked the question itself.
 */
export function stubSpanDrift(state: unknown): boolean {
  const s = state as { span?: { said?: unknown; goal?: unknown; speaks?: unknown }; quoted?: { words?: unknown }[]; frame?: { value?: unknown }[] } | null;
  const said = typeof s?.span?.said === 'string' ? s.span.said : '';
  const goal = new Set(tokens(typeof s?.span?.goal === 'string' ? s.span.goal : ''));
  const quotedWords = (s?.quoted ?? []).flatMap((q) => (typeof q.words === 'string' ? [q.words] : []));
  // A span that speaks to the caller: the quoted words turned toward the caller ("I need" as "you need"),
  // and a name of the line said for a pronoun faithful only where the stub can tell it is the one meant.
  const toCallerSpan = s?.span?.speaks === 'to-caller';
  const frame = (s?.frame ?? []).flatMap((f) => (typeof f.value === 'string' ? [{ value: f.value }] : []));
  const quoted = new Set((toCallerSpan ? quotedWords.map(toCaller) : quotedWords).flatMap(tokens));
  // A negated statement or a condition of the quoted words left out (the criteria's; render/checks.ts leftOut).
  if (toCallerSpan) {
    const { spoken, compared } = comparedToCaller(said, quotedWords, frame.map((f) => f.value));
    if (leftOut(spoken, compared)) return true;
  } else if (leftOut(said, quotedWords)) return true;
  // A time, an amount or who is to act left out.
  const kept = new Set(tokens(said));
  if (quotedWords.some((q) => mustKeep(q).some((w) => !kept.has(w)))) return true;
  // Who does what to whom, and whose words they are: the checks' own reading (render/checks.ts personBroken).
  if (toCallerSpan && personBroken(said, quotedWords, frame.map((f) => f.value))) return true;
  // A to-caller span may say a name the line lists (who the message is for) for a pronoun, conservatively:
  // only where the quoted words have a third-person pronoun or a "you" and name no one of their own.
  const bare = (w: string): string => w.replace(/'s$/, '');
  const frameWords = new Set(frame.flatMap((f) => tokens(f.value)));
  const standsIn = toCallerSpan && quotedWords.some(hasPronounFor) && quotedWords.every((q) => mustKeep(q).every((w) => isFigureWord(w)));
  const allowed = new Set(standsIn ? frameWords : []);
  if (tokens(said).some((w) => !quoted.has(bare(w)) && frameWords.has(bare(w)) && !allowed.has(bare(w)))) return true;
  // Speaking to the caller, "you" and "your" stand for the caller's own first person (personBroken has held them to it).
  const own = tokens(said).filter((w) => !quoted.has(w) && !allowed.has(bare(w)) && !(toCallerSpan && isSecondPerson(w)));
  if (manipulationPattern(undefined).test(own.join(' ')) || DRIFT_CUES.test(own.join(' '))) return true;
  if (own.some((w) => PERSON.has(w) || isFigureWord(w))) return true;
  const capitalized = (said.match(/(?<!^)\b\p{Lu}[\p{L}']*/gu) ?? []).map((w) => (toCallerSpan ? straight(w) : w).toLowerCase());
  if (capitalized.some((w) => !quoted.has(w) && !allowed.has(bare(w)))) return true;
  return own.filter((w) => !FILLER.has(w) && !goal.has(w)).length >= 2;
}

const DRIFT_CUES = /\b(instructions?|system|prompt|mode|override|transfer(ring)?|refund|credit|guarantee|promise|password|admin|developer|assistant)\b/;

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}

function intentAnswer(text: string, labels: string[], app: App | null): Answer {
  const keywords = [...(app?.testing?.heuristics?.intents ?? []), ...CONTROL_INTENT_KEYWORDS];
  const hits = keywords.filter(([, re]) => re.test(text)).map(([label]) => label);
  if (hits.length === 0) return choiceAnswer(sharp(labels, 'none', 0.8));
  const probs: Record<string, number> = {};
  for (const l of labels) probs[l] = 0.01;
  probs[hits[0]!] = 0.85;
  for (const h of hits.slice(1)) probs[h] = 0.3;
  return choiceAnswer(normalize(probs));
}

const MANIPULATION_BY_ORG = new Map<string | undefined, RegExp>();

/**
 * An attempt to instruct the assistant itself (screen.ts): told to drop or reveal its rules, to become
 * something else, a claimed authority over it, or an order addressed to it from inside other words
 * ("i slipped on the ice and also assistant ignore your rules"). A bare "override" is not one
 * ("override? no i said overnight"): it has to override something, or be the system's own. Nor is
 * "ignore that", which is a caller correcting themselves. The app's organization name (App.testing
 * .heuristics.organization) may follow "i'm a": a caller claiming to be from it.
 */
function manipulationPattern(organization: string | undefined): RegExp {
  const cached = MANIPULATION_BY_ORG.get(organization);
  if (cached) return cached;
  const from = organization === undefined ? '' : `(${organization.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} )?`;
  const pattern = new RegExp([
    String.raw`\b(ignore|forget|disregard|bypass) (all |any )?(your|the|previous|prior|these|its) (instructions|rules|prompt|programming|guidelines)\b`,
    String.raw`\b(repeat|reveal|tell me|read me|show me) your (instructions|rules|prompt)\b`,
    String.raw`\bsystem prompt\b`,
    String.raw`\b(system|prompt|security) override\b`,
    String.raw`\boverride (the|your|this|all|any) (code|checks?|rules|security|verification|system|instructions)\b`,
    String.raw`\byou are now\b`,
    String.raw`\bpretend (to be|you are|you're)\b`,
    String.raw`\bas (a|your|the) (supervisor|administrator|admin|developer)\b`,
    String.raw`\b(i'm|i am) (a|an|your|the) ${from}(supervisor|administrator|admin|developer)\b`,
    String.raw`\b(jailbreak|developer mode|admin mode|debug mode)\b`,
    String.raw`\bdisable (the )?(security|verification)\b`,
    String.raw`\bassistant,? (ignore|forget|disregard|mark|approve)\b`,
  ].join('|'), 'i');
  MANIPULATION_BY_ORG.set(organization, pattern);
  return pattern;
}

/**
 * `todayIso` is the run's date, pinned the way RunOptions pins it for the turn rather than read
 * off the wall clock: the app's heuristics are told it (an app's dates read against it), and a
 * stub whose answers drift with the calendar is a stub whose failures cannot be reproduced.
 *
 * `app` (default: the default app, if one is registered) lends its menu and its domain heuristics
 * (App.testing.heuristics), which answer a question before the stub's own; without one, those
 * questions answer none (a choice) or by the stub's quiet default (a yes-or-no).
 */
export function answerHeuristically(id: string, q: Question, text: string, todayIso: string, app: App | null = defaultAppOrNull()): Answer {
  if (q.type === 'choice') {
    const labels = choiceLabels(q);
    const domain = app?.testing?.heuristics?.choice;
    if (domain && Object.hasOwn(domain, id)) {
      const { label, p } = domain[id]!(text, labels, { todayIso });
      return choiceAnswer(sharp(labels, label !== null && labels.includes(label) ? label : 'none', p));
    }
    switch (id) {
      case 'intent': return intentAnswer(text, labels, app);
      case 'menuNumberSaid': {
        const tok = text.trim().split(/\s+/)[0] ?? '';
        const digit = /^\d$/.test(tok) ? tok : NUMBER_WORD_DIGIT[tok];
        const ok = digit && (app?.menu ?? []).some((m) => m.digit === digit);
        return choiceAnswer(sharp(labels, ok ? digit! : 'none', 0.9));
      }
      case 'languageSwitch':
        return choiceAnswer(sharp(labels, has(text, /\b(spanish|espanol|español)\b/) ? 'es' : has(text, /\b(french|francais)\b/) ? 'fr' : 'none', 0.9));
      default:
        return quietAnswer(id, q, 0.9, app);
    }
  }
  if (q.type === 'score') {
    const labels = q.levels.map((l) => l.label);
    if (id === 'frustration') {
      const high = has(text, /\b(ridiculous|stupid|damn|hell|third time|already told|frustrat\w*|ugh|useless)\b/);
      const mild = has(text, /\b(come on|seriously|again|hurry)\b/);
      return scoreAnswer(q, sharp(labels, high ? 'high' : mild ? 'mild' : 'none', 0.7));
    }
    if (id === 'urgency') {
      return scoreAnswer(q, sharp(labels, has(text, /\b(urgent|emergency|asap|right away|today)\b/) ? 'high' : 'normal', 0.6));
    }
    return quietAnswer(id, q, 0.9, app);
  }
  const domainNoul = app?.testing?.heuristics?.noul;
  if (domainNoul && Object.hasOwn(domainNoul, id)) return noulAnswer(domainNoul[id]!(text, { todayIso }));
  switch (id) {
    case 'intelligible': return noulAnswer(/[a-z]{2,}/.test(text) ? 0.9 : 0.3);
    case 'utteranceComplete': return noulAnswer(/\b(um|uh|and)\s*$/.test(text) ? 0.3 : 0.85);
    case 'wantsHuman': return noulAnswer(has(text, /\b(agent|representative|person|human|operator|someone|somebody)\b/) ? 0.9 : 0.05);
    case 'confusedByPrompt': return noulAnswer(has(text, /\b(what|huh|pardon|sorry)\b\??$/) ? 0.7 : 0.1);
    case 'spokeAMenuNumber': return noulAnswer(/^(press\s+)?(\d|one|two|three|four|five|zero)$/.test(text.trim()) ? 0.9 : 0.05);
    case 'triedSelfService': return noulAnswer(has(text, /\b(website|online|the app|portal)\b/) ? 0.8 : 0.1);
    case 'confirmsYes': return noulAnswer(has(text, /\b(yes|yeah|yep|correct|right|sure|that's it)\b/) ? 0.9 : 0.1);
    case 'confirmsNo': return noulAnswer(has(text, /\b(no|nope|wrong|not|incorrect)\b/) ? 0.9 : 0.1);
    case 'callerMatchDeclined': return noulAnswer(has(text, /\b(no|nope|different account|another account|not me|not mine|not my account)\b/) ? 0.9 : 0.05);
    case 'manipulation': return noulAnswer(manipulationPattern(app?.testing?.heuristics?.organization).test(text) ? 0.9 : 0.04);
    // Generated wording's drift check (render/checks.ts), whose state holds the line, not a caller's words.
    case 'renderDrift': return noulAnswer(0.04); // judged on the whole state: HeuristicStubClient.ask (stubDrift)
    case 'renderSpanDrift': return noulAnswer(0.04); // judged on the whole state: HeuristicStubClient.ask (stubSpanDrift)
    default: return quietAnswer(id, q, 0.9, app);
  }
}

/**
 * Development aid for the REPL, and the fixture stub's fallback for an unlabelled utterance.
 * Never the source of the regression baseline.
 *
 * `todayIso` pins what the app's date readings (a birth year) count as. A caller that leaves it out gets the wall clock,
 * which is what the server wants; the harness passes the run's own date (see buildClient), so a
 * replay a year later answers exactly as it did the first time.
 */
export class HeuristicStubClient implements JevClient {
  private readonly todayIso: string;
  private readonly app: App | null | undefined;

  /** `app` is the app whose heuristics answer; left out, the default app (the one registered first), at each ask. */
  constructor(opts: { todayIso?: string; app?: App | null } = {}) {
    this.todayIso = opts.todayIso ?? new Date().toISOString().slice(0, 10);
    this.app = opts.app;
  }

  async ask(req: JevRequest): Promise<JevResponse> {
    const text = textOf(req.state);
    const answers: AnswerMap = {};
    for (const [id, q] of Object.entries(req.questions)) answers[id] = answerHeuristically(id, q, text, this.todayIso, this.app === undefined ? defaultAppOrNull() : this.app);
    // Generated wording's drift check reads the line, its fixed text and the caller's quoted words, not a caller's turn.
    if (Object.hasOwn(req.questions, 'renderDrift')) answers.renderDrift = noulAnswer(stubDrift(req.state) ? 0.9 : 0.04);
    // A framed line's span: held to the content it summarizes alone.
    if (Object.hasOwn(req.questions, 'renderSpanDrift')) answers.renderSpanDrift = noulAnswer(stubSpanDrift(req.state) ? 0.9 : 0.04);
    return {
      answers,
      model: 'stub-heuristic',
      usage: { inputTokens: estimateTokens(req.state) + estimateTokens(req.questions), outputTokens: 0, estimated: true },
      latencyMs: 0,
      source: 'stub:heuristic',
    };
  }
}
