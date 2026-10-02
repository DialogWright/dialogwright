import { describe, expect, it, vi } from 'vitest';
import { SUMMARY_MODEL, plainNote, summarizeHandoff as summarizeIn, type SummaryOptions } from './summary';
import { TESTKIT_HANDOFF } from '../testing/testkit/domain/present';
import type { AuditEntry } from '../audit/types';

const ENTRIES: readonly AuditEntry[] = [
  { type: 'call_started', detail: { channel: 'voice', principal: 'anonymous', level: 0 }, seq: 1, at: '2026-09-18T00:00:00.000Z', callId: 'CA-test-1', channel: 'voice', prevHash: '0'.repeat(64), hash: 'a'.repeat(64) },
  { type: 'identity', detail: { factor: 'account_id_dob', pass: true, level: 1 }, seq: 2, at: '2026-09-18T00:00:01.000Z', callId: 'CA-test-1', channel: 'voice', prevHash: 'a'.repeat(64), hash: 'b'.repeat(64) },
];

/** The summary as the testkit's calls ask for it (App.handoff). */
const summarizeHandoff = (entries: readonly AuditEntry[], o: SummaryOptions) => summarizeIn(entries, o, TESTKIT_HANDOFF);

function okResponse(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
}

describe('summarizeHandoff', () => {
  it('sends the right url, headers, model, and the audit entries stripped of hashes', async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse('Note for the agent.'));
    await summarizeHandoff(ENTRIES, { apiKey: 'sk-test', fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    // The key sits only in x-api-key, never anywhere else on the request.
    expect(Object.keys(init.headers as Record<string, string>).filter((k) => (init.headers as Record<string, string>)[k] === 'sk-test')).toEqual(['x-api-key']);
    const body = JSON.parse(init.body as string) as { model: string; max_tokens: number; messages: { role: string; content: string }[] };
    expect(body.model).toBe(SUMMARY_MODEL);
    expect(body.max_tokens).toBe(200);
    const sent = JSON.parse(body.messages[0]!.content) as { facts: { identity: string }; entries: unknown[] };
    expect(sent.entries).toEqual(ENTRIES.map(({ type, detail, at }) => ({ type, detail, at })));
    for (const e of sent.entries) expect(e).not.toHaveProperty('hash');
    // The authoritative facts ride along, read from the same entries.
    expect(sent.facts.identity).toBe('level 1 (account ID and date of birth)');
    expect(JSON.stringify(body)).not.toContain('sk-test');
  });

  it('returns the text block on a 200 body', async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse('Wanted: a parcel status update\nDone: verified the caller\nNext: give the status'));
    await expect(summarizeHandoff(ENTRIES, { apiKey: 'k', fetch })).resolves.toBe(
      'Identity: level 1 (account ID and date of birth)\nWanted: a parcel status update\nDone: verified the caller\nBlocked: none\nNext: give the status',
    );
  });

  it('joins multiple text blocks and trims the result', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'Wanted: a delivery window ' }, { type: 'text', text: 'Next: answer it' }] }), { status: 200 }),
    );
    const note = await summarizeHandoff(ENTRIES, { apiKey: 'k', fetch });
    expect(note).toContain('Wanted: a delivery window');
    expect(note).toContain('Next: answer it');
  });

  it('returns null on a non-2xx response', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('server error', { status: 500 }));
    await expect(summarizeHandoff(ENTRIES, { apiKey: 'k', fetch })).resolves.toBeNull();
  });

  it('returns null when fetch throws', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(summarizeHandoff(ENTRIES, { apiKey: 'k', fetch })).resolves.toBeNull();
  });

  it('returns null when the response has no text content', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [] }), { status: 200 }));
    await expect(summarizeHandoff(ENTRIES, { apiKey: 'k', fetch })).resolves.toBeNull();
  });

  it('never logs or prints the api key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetch = vi.fn().mockRejectedValue(new Error('boom'));
    await summarizeHandoff(ENTRIES, { apiKey: 'super-secret-key', fetch });
    const printed = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map((v) => JSON.stringify(v)).join(' ');
    expect(printed).not.toContain('super-secret-key');
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('strips markdown the model adds anyway, keeping the labelled lines', async () => {
    const md = '**Identity:** level 2 (account ID, date of birth and code)\n\n- **Wanted:** status of parcel 7101\n- *Blocked:* parcel 7201 is outside the caller\'s scope\n### Next\n`Offer authorization forms`';
    const fetch = vi.fn().mockResolvedValue(okResponse(md));
    const note = (await summarizeHandoff(ENTRIES, { apiKey: 'k', fetch }))!;
    expect(note).not.toMatch(/[*#`]/);
    expect(note.split('\n')).toHaveLength(5);
    expect(note).toContain('Wanted: status of parcel 7101');
    // Identity and Blocked come from the audit entries, not from what the model wrote.
    expect(note).toContain('Identity: level 1 (account ID and date of birth)');
    expect(note).toContain('Blocked: none');
  });

  it('asks for plain labelled lines, not markdown', async () => {
    const fetch = vi.fn().mockResolvedValue(okResponse('x'));
    await summarizeHandoff(ENTRIES, { apiKey: 'k', fetch });
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as { system: string };
    expect(body.system).toContain('no markdown');
    expect(body.system).toContain('The facts are authoritative');
    expect(body.system).toContain('Wanted:');
    expect(body.system).toContain('Next:');
  });

  it("names the app's support line in the instructions, and a neutral one without the app's words", async () => {
    const fetch = vi.fn().mockImplementation(async () => okResponse('Wanted: help'));
    await summarizeHandoff(ENTRIES, { apiKey: 'k', fetch });
    const app = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string) as { system: string };
    expect(app.system).toMatch(/^You write handoff notes for a human parcel delivery support agent who is taking over a call/);
    const neutral = await summarizeIn(ENTRIES, { apiKey: 'k', fetch });
    const body = JSON.parse((fetch.mock.calls[1] as [string, RequestInit])[1].body as string) as { system: string; messages: { content: string }[] };
    expect(body.system).toMatch(/^You write handoff notes for a human contact-center agent who is taking over a call/);
    expect((JSON.parse(body.messages[0]!.content) as { facts: { identity: string } }).facts.identity).toBe('level 1');
    expect(neutral).toContain('Identity: level 1\n');
  });
});

describe('plainNote', () => {
  it('leaves plain text and underscores inside words alone', () => {
    expect(plainNote('Identity: level 1\nNext: call back re account_id')).toBe('Identity: level 1\nNext: call back re account_id');
  });

  it('removes numbered-list markers and collapses blank runs', () => {
    expect(plainNote('1. Identity: level 0\n\n\n\n2) Next: verify')).toBe('Identity: level 0\n\nNext: verify');
  });
});
