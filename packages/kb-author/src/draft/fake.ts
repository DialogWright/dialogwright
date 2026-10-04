import type { Draft, DraftRequest, Drafter, ProposedTopic } from './drafter';

/**
 * A drafter for tests: no model, no network. It drafts from fixed rules, each naming a section (of
 * one document, or of any) and the draft to give for it, in the order the rules are listed. A rule
 * without an excerpt quotes the section's first sentence. The same rules give the same drafts.
 */

export interface FakeRule {
  /** The source document's id; any document's section of that id when left out. */
  document?: string;
  section: string;
  topic: string | ProposedTopic;
  answer: string;
  excerpt?: string;
  applies?: Draft['applies'];
  effective?: Draft['effective'];
}

/** A section's first sentence: up to the first full stop, question or exclamation mark followed by a space, or all of it. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  return end < 0 ? flat : flat.slice(0, end + 1);
}

export class FakeDrafter implements Drafter {
  readonly id: string;
  /** Every request it was given, in order (for a test to read). */
  readonly requests: DraftRequest[] = [];

  constructor(
    private readonly rules: readonly FakeRule[],
    id = 'fake-drafter',
  ) {
    this.id = id;
  }

  async draft(request: DraftRequest): Promise<Draft[]> {
    this.requests.push(request);
    const out: Draft[] = [];
    for (const rule of this.rules) {
      if (rule.document !== undefined && rule.document !== request.source.id) continue;
      if (!Object.hasOwn(request.source.sections, rule.section)) continue;
      out.push({
        topic: rule.topic,
        answer: rule.answer,
        excerpt: rule.excerpt ?? firstSentence(request.source.sections[rule.section]!.text),
        section: rule.section,
        ...(rule.applies ? { applies: rule.applies } : {}),
        ...(rule.effective ? { effective: rule.effective } : {}),
      });
    }
    return out;
  }
}
