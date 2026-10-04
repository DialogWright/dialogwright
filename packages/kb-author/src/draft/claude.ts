import { DraftError, type Draft, type DraftRequest, type Drafter } from './drafter';

/**
 * The Claude drafter: asks a Claude model, through the Messages API and the user's own key, for draft
 * passages of one source document, as JSON that a schema holds to its shape (structured outputs,
 * `output_config.format`). It uses Node's fetch and no SDK, so the package adds no dependency.
 *
 * - The key is read from `ANTHROPIC_API_KEY` when a request is made, and only put in the request's
 *   `x-api-key` header: never logged, never in an error message, never written anywhere.
 * - It is for authoring on the author's machine: kb:draft refuses to run it in CI, and no test makes
 *   a real call (the one live test is skipped unless ANTHROPIC_API_KEY and DIALOGWRIGHT_LIVE_DRAFT=1
 *   are both set).
 * - A long document is sent in parts of whole sections, each part one request.
 * - What it returns is only a proposal: kb:draft checks every draft (./validate.ts), and a person
 *   approves each one before it can be said.
 */

/** The model used when none is given: Claude Haiku 4.5, the least costly current model, which drafting short answers needs no more than. */
export const DEFAULT_DRAFT_MODEL = 'claude-haiku-4-5';
export const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** About how many characters of sections go in one request. */
export const CHARS_PER_REQUEST = 24_000;
const MAX_TOKENS = 8_000;

export interface ClaudeDrafterOptions {
  /** The model id. Default DEFAULT_DRAFT_MODEL. */
  model?: string;
  /** The fetch to use (a test's). Default: Node's. */
  fetch?: typeof globalThis.fetch;
  /** Where the key comes from, read at each request. Default: process.env.ANTHROPIC_API_KEY. */
  apiKey?: () => string | undefined;
  /** The Messages API's URL. */
  url?: string;
}

/** The instructions the model is given. */
export const SYSTEM_PROMPT = [
  'You draft entries for a voice agent\'s knowledge base from one source document. Each entry answers one question a caller could ask, and is read aloud word for word, only after a person reviews and approves it.',
  'For each answer the document supports:',
  '- Write the answer as one or two short spoken sentences, at most the number of characters you are given, in the language you are given. Say it to the caller ("you", "we"), in plain words.',
  '- Say only what the document says. Add no advice, no opinion, no promise and nothing from outside the document. Leave out anything the document does not state.',
  '- Never use variables, placeholders, braces or markup: the answer is fixed text.',
  '- Copy into "excerpt" the exact words of the section that support the answer, character for character: a sentence or a few, never paraphrased, never joined across sections.',
  '- Give "section" as the id of the section the excerpt is copied from.',
  '- Use an existing topic id in "topic" when the answer fits it, with "newTopic" null. Otherwise give a new topic id (lowercase letters, digits and underscores, starting with a letter) and "newTopic" with a short title, a few exact keywords, and two or three example questions in a caller\'s words.',
  '- Use "applies" only when the document says the answer is for some callers and not others, with the facts and values you are given; otherwise an empty list. Give "effectiveFrom" and "effectiveTo" (YYYY-MM-DD) only when the document states the dates; otherwise null.',
  '- Draft nothing for a section that answers no caller\'s question (a title, a table of contents, a notice with no fact in it).',
].join('\n');

/** The JSON Schema the response is held to. Every object is closed and every field required (null where it may be absent), as structured outputs require. */
export const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['drafts'],
  properties: {
    drafts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'topic', 'newTopic', 'answer', 'excerpt', 'applies', 'effectiveFrom', 'effectiveTo'],
        properties: {
          section: { type: 'string', description: 'The id of the section the excerpt is copied from.' },
          topic: { type: 'string', description: 'An existing topic id, or a new one (lowercase letters, digits, underscores).' },
          newTopic: {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'keywords', 'asks'],
                properties: { title: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, asks: { type: 'array', items: { type: 'string' } } },
              },
            ],
          },
          answer: { type: 'string', description: 'One or two short spoken sentences.' },
          excerpt: { type: 'string', description: 'The exact words of the section that support the answer.' },
          applies: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['fact', 'values'], properties: { fact: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } } },
          },
          effectiveFrom: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
          effectiveTo: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
        },
      },
    },
  },
} as const;

/** The sections of a request in parts of about CHARS_PER_REQUEST characters, whole sections each. */
export function partsOf(sections: Readonly<Record<string, { heading?: string; text: string }>>): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const [id, s] of Object.entries(sections)) {
    const n = s.text.length + (s.heading?.length ?? 0) + id.length;
    if (current.length > 0 && size + n > CHARS_PER_REQUEST) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(id);
    size += n;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** The user message for one part of a document. */
export function userMessage(request: DraftRequest, sectionIds: readonly string[]): string {
  const topics = request.existingTopics.length === 0 ? '(none yet)' : request.existingTopics.map((t) => `- ${t.id}: ${t.title}${t.keywords.length > 0 ? ` (keywords: ${t.keywords.join(', ')})` : ''}`).join('\n');
  const applies = Object.keys(request.applies).length === 0 ? '(none: every answer is for every caller)' : Object.entries(request.applies).map(([fact, values]) => `- ${fact}: ${values.join(', ')}`).join('\n');
  const sections = sectionIds
    .map((id) => {
      const s = request.source.sections[id]!;
      return `<section id="${id}">\n${s.heading !== undefined ? `${s.heading}\n` : ''}${s.text}\n</section>`;
    })
    .join('\n');
  return [
    `Language: ${request.locale}`,
    `Longest answer: ${request.maxAnswerChars} characters`,
    `Existing topics:\n${topics}`,
    `Facts an answer can depend on:\n${applies}`,
    ...(request.topicHints.length > 0 ? [`The author asks for drafts about: ${request.topicHints.join('; ')}`] : []),
    `Document: ${request.source.document}`,
    sections,
  ].join('\n\n');
}

/** The Messages API request body for one part. */
export function requestBody(model: string, request: DraftRequest, sectionIds: readonly string[]): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage(request, sectionIds) }],
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
  };
}

interface ResponseDraft {
  section: string;
  topic: string;
  newTopic: { title: string; keywords: string[]; asks: string[] } | null;
  answer: string;
  excerpt: string;
  applies: { fact: string; values: string[] }[];
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/** The drafts of one response's JSON. */
export function draftsOfResponse(json: unknown): Draft[] {
  const drafts = (json as { drafts?: unknown })?.drafts;
  if (!Array.isArray(drafts)) throw new DraftError('the model\'s answer has no list of drafts');
  return (drafts as ResponseDraft[]).map((d) => {
    const applies = Object.fromEntries((d.applies ?? []).filter((a) => a.values.length > 0).map((a) => [a.fact, a.values.length === 1 ? a.values[0]! : a.values]));
    return {
      topic: d.newTopic ? { id: d.topic, title: d.newTopic.title, keywords: d.newTopic.keywords, asks: d.newTopic.asks } : d.topic,
      answer: d.answer,
      excerpt: d.excerpt,
      section: d.section,
      ...(Object.keys(applies).length > 0 ? { applies } : {}),
      ...(d.effectiveFrom ? { effective: { from: d.effectiveFrom, ...(d.effectiveTo ? { to: d.effectiveTo } : {}) } } : {}),
    };
  });
}

export class ClaudeDrafter implements Drafter {
  readonly id: string;
  readonly model: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly apiKey: () => string | undefined;
  private readonly url: string;

  constructor(options: ClaudeDrafterOptions = {}) {
    this.model = options.model ?? DEFAULT_DRAFT_MODEL;
    this.id = `kb:draft claude ${this.model}`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.apiKey = options.apiKey ?? (() => process.env.ANTHROPIC_API_KEY);
    this.url = options.url ?? MESSAGES_URL;
  }

  async draft(request: DraftRequest): Promise<Draft[]> {
    const out: Draft[] = [];
    for (const part of partsOf(request.source.sections)) out.push(...(await this.ask(request, part)));
    return out;
  }

  private async ask(request: DraftRequest, sectionIds: readonly string[]): Promise<Draft[]> {
    const key = this.apiKey();
    if (key === undefined || key.trim() === '') throw new DraftError('ANTHROPIC_API_KEY is not set: put your own key in the environment (or in .env where you run the command)');
    let response: Response;
    try {
      response = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify(requestBody(this.model, request, sectionIds)),
      });
    } catch (error) {
      throw new DraftError(`the Messages API could not be reached (${scrub(error instanceof Error ? error.message : String(error), key)})`);
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new DraftError(`the Messages API answered ${response.status} with something that is not JSON`);
    }
    if (!response.ok) {
      const message = (body as { error?: { message?: unknown } })?.error?.message;
      throw new DraftError(`the Messages API answered ${response.status}${typeof message === 'string' ? `: ${scrub(message, key)}` : ''}`);
    }
    const message = body as { stop_reason?: string; content?: { type: string; text?: string }[] };
    if (message.stop_reason === 'refusal') throw new DraftError('the model declined to draft from this document');
    if (message.stop_reason === 'max_tokens') throw new DraftError('the model\'s answer was cut off at its length limit: ingest the document in smaller parts');
    const json = (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    try {
      return draftsOfResponse(JSON.parse(json));
    } catch (error) {
      if (error instanceof DraftError) throw error;
      throw new DraftError('the model\'s answer is not the JSON asked for');
    }
  }
}

/** A message with the key taken out, should it ever be in one. */
function scrub(message: string, key: string): string {
  return key.length >= 8 ? message.split(key).join('[key]') : message;
}
