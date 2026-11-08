import { describe, expect, it } from 'vitest';
import { agentAnswerSchema, agentJsonSchema, parseAgentAnswer } from './schema';

/** The agent's answer: its zod schema (what the engine accepts) and the JSON Schema the model is asked to answer in. */

const valid = { reply: 'Sure, what day suits you?', values: [{ field: 'day', value: '2026-11-12', words: 'Thursday' }], action: 'none', fromFacts: false };

describe('agentAnswerSchema', () => {
  it('accepts an answer in the shape, its action one of the app\'s', () => {
    expect(agentAnswerSchema(['submit', 'none']).safeParse(valid).success).toBe(true);
  });

  it('an answer naming an action the app lacks is refused', () => {
    expect(agentAnswerSchema(['submit', 'none']).safeParse({ reply: 'x', values: [], action: 'book', fromFacts: false }).success).toBe(false);
  });

  it('always allows none, even where the app names no action', () => {
    expect(agentAnswerSchema([]).safeParse({ ...valid, values: [] }).success).toBe(true);
  });

  it('a value missing its words is refused, and so is one whose words are empty', () => {
    const schema = agentAnswerSchema(['none']);
    expect(schema.safeParse({ ...valid, values: [{ field: 'day', value: '2026-11-12' }] }).success).toBe(false);
    expect(schema.safeParse({ ...valid, values: [{ field: 'day', value: '2026-11-12', words: ' ' }] }).success).toBe(false);
  });

  it('a field the form does not have is refused where the fields are given', () => {
    expect(agentAnswerSchema(['none'], ['name']).safeParse(valid).success).toBe(false);
    expect(agentAnswerSchema(['none'], ['day']).safeParse(valid).success).toBe(true);
  });

  it('refuses keys the shape does not have', () => {
    expect(agentAnswerSchema(['none']).safeParse({ ...valid, extra: 1 }).success).toBe(false);
    expect(agentAnswerSchema(['none']).safeParse({ ...valid, values: [{ ...valid.values[0], note: 'x' }] }).success).toBe(false);
  });
});

describe('agentJsonSchema', () => {
  it('is strict: every object closed, every field required, the action and the fields enumerated', () => {
    const s = agentJsonSchema(['submit'], ['day', 'window']) as { additionalProperties: boolean; required: string[]; properties: Record<string, { enum?: string[]; items?: { additionalProperties: boolean; required: string[]; properties: Record<string, { enum?: string[] }> } }> };
    expect(s.additionalProperties).toBe(false);
    expect([...s.required].sort()).toEqual(['action', 'fromFacts', 'reply', 'values']);
    expect(s.properties.action!.enum).toEqual(['submit', 'none']);
    const item = s.properties.values!.items!;
    expect(item.additionalProperties).toBe(false);
    expect([...item.required].sort()).toEqual(['field', 'value', 'words']);
    expect(item.properties.field!.enum).toEqual(['day', 'window']);
  });
});

describe('parseAgentAnswer', () => {
  it('reads a body in the shape', () => {
    expect(parseAgentAnswer(JSON.stringify(valid), ['none'])).toEqual({ ok: true, answer: valid });
  });

  it('a body that is not JSON, or not the shape, is invalid, saying why', () => {
    const notJson = parseAgentAnswer('Sure! {"reply"', ['none']);
    expect(notJson).toMatchObject({ ok: false });
    expect(!notJson.ok && notJson.detail).toContain('not JSON');
    const notShape = parseAgentAnswer(JSON.stringify({ ...valid, action: 'book' }), ['none']);
    expect(!notShape.ok && notShape.detail).toContain('action');
  });

  it('reads an answer wrapped in a code fence, as some models send one', () => {
    expect(parseAgentAnswer(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``, ['none'])).toEqual({ ok: true, answer: valid });
  });
});
