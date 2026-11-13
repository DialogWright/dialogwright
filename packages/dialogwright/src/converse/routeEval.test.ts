import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { routeEvalCommand, routeCassettePath } from '../harness-text/routeEvalCommand';
import { JevClientError, type AnswerMap, type JevClient, type JevRequest } from '../jev/types';
import { JOURNEYS_YAML, LEAVE_NOTE_ACTION } from '../testing/converse/journeys';
import { agentBusinessProblems } from './business/load';
import { loadRouteCalls, loadRouteLabels, routeCases, scoreRoutes, type RouteCall, type RouteLabel } from './routeEval';

const base = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'testing', 'converse', 'agent.yaml'), 'utf8');
const built = agentBusinessProblems(base + LEAVE_NOTE_ACTION + JOURNEYS_YAML);
const b = built.value!;
const BARS = [0.4, 0.5, 0.6, 0.7, 0.8] as const;

const call = (id: string, said: string[]): RouteCall => ({ id, account: false, turns: said.flatMap((s) => [{ who: 'line' as const, text: `line before ${s}` }, { who: 'caller' as const, text: s }]) });
const label = (id: string, turn: number, task: string, extra: Partial<RouteLabel> = {}): RouteLabel => ({ id, turn, task, ...extra });

describe('routeCases', () => {
  it('builds the fixture business', () => {
    expect(built.problems).toEqual([]);
  });

  it('replays labels into states: visit, visit, note, visit gives root, visit, visit, then note with visit paused', () => {
    const c = call('f/a-1', ['v1', 'v2', 'n1', 'v3']);
    const labels = [label('f/a-1', 0, 'visit'), label('f/a-1', 1, 'visit'), label('f/a-1', 2, 'note'), label('f/a-1', 3, 'visit')];
    const cases = routeCases(b, [c], labels);
    expect(cases.map((x) => x.id)).toEqual(['f/a-1#0', 'f/a-1#1', 'f/a-1#2', 'f/a-1#3']);
    expect(cases.map((x) => [x.journey.active, x.journey.paused])).toEqual([[null, null], ['visit', null], ['visit', null], ['note', 'visit']]);
    expect((cases[2]!.state as { said: string; lastReply: string }).said).toBe('n1');
    expect((cases[2]!.state as { lastReply: string }).lastReply).toBe('line before n1');
    expect(Object.keys((cases[0]!.questions.task as { criteria: object }).criteria)).toEqual(['visit', 'note', 'none']);
    expect(cases[1]!.expected.task).toBe('visit');
  });

  it('makes no case of a confirmed yes and completes the journey with it', () => {
    const c = call('f/a-1', ['book it', 'yes', 'another please']);
    const labels = [label('f/a-1', 0, 'visit'), label('f/a-1', 1, 'visit', { confirms: 'book' }), label('f/a-1', 2, 'visit', { again: true })];
    const cases = routeCases(b, [c], labels);
    expect(cases.map((x) => x.id)).toEqual(['f/a-1#0', 'f/a-1#2']);
    expect(cases[1]!.journey.phase).toBe('after');
    expect(Object.keys(cases[1]!.questions)).toEqual(['task', 'again']);
  });

  it('skips a turn with no label and counts it', () => {
    const c = call('f/a-1', ['v1', 'v2']);
    const cases = routeCases(b, [c, call('f/b-1', ['x'])], [label('f/a-1', 1, 'visit')]);
    expect(cases.map((x) => x.id)).toEqual(['f/a-1#1']);
  });
});

/** Answers by what the caller said: task probabilities. */
const reading = (task: Record<string, number>, drops?: number): AnswerMap => {
  const top = Object.entries(task).sort((x, y) => y[1] - x[1])[0]!;
  const answers: AnswerMap = { task: { type: 'choice', choice: top[0], probabilities: task, confidence: top[1] } };
  if (drops !== undefined) answers.drops = { type: 'noul', noul: drops };
  return answers;
};

describe('scoreRoutes', () => {
  const c = call('f/a-1', ['v1', 'carry on', 'n1']);
  const labels = [label('f/a-1', 0, 'visit'), label('f/a-1', 1, 'visit'), label('f/a-1', 2, 'none')];
  const cases = routeCases(b, [c], labels);

  it('counts a switch on a turn labelled carry as a wrong switch, and a carry on a turn labelled a switch as missed', () => {
    const answers = new Map<string, AnswerMap | null>([
      ['f/a-1#0', reading({ visit: 0.1, note: 0.1, none: 0.8 })], // missed start
      ['f/a-1#1', reading({ visit: 0.1, note: 0.9, none: 0 }, 0.1)], // wrong switch (label: carry)
      ['f/a-1#2', reading({ visit: 0.9, note: 0, none: 0.1 }, 0.1)], // carry, label none: right at 0.6? active visit stays
    ]);
    const r = scoreRoutes(b, cases, answers, BARS);
    expect(r.cases).toBe(3);
    expect(r.wrongSwitches).toBe(1);
    expect(r.missedSwitches).toBe(1);
    expect(r.unanswered).toBe(0);
    expect(r.accuracy).toBeCloseTo(1 / 3, 6);
    expect(r.byBar.map((x) => x.bar)).toEqual([...BARS]);
    // At 0.95 nothing reaches: the bars matter. At 0.8 the wrong switch (0.9) is still there.
    expect(r.byBar.find((x) => x.bar === 0.8)!.wrongSwitches).toBe(1);
    expect(JSON.stringify(r)).not.toContain('carry on');
  });

  it('counts an unanswered case and reads it as carry, as a call would', () => {
    const r = scoreRoutes(b, cases, new Map([['f/a-1#0', null]]), BARS);
    expect(r.unanswered).toBe(3);
    expect(r.missedSwitches).toBe(1);
  });
});

describe('the files', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const folder = (name: string): string => {
    const d = join(mkdtempSync(join(tmpdir(), 'route-eval-')), name);
    mkdirSync(d);
    dirs.push(d);
    return d;
  };

  it('reads calls from results.jsonl, prefixed with the folder, an account where the persona calls from a number', () => {
    const dir = folder('run-1');
    const row = (persona: string) => JSON.stringify({ persona, run: 2, call: { persona, turns: [{ who: 'line', text: 'hi', atMs: 0 }, { who: 'caller', text: 'hello', atMs: 1 }], ended: true, callId: 'x' } });
    writeFileSync(join(dir, 'results.jsonl'), `${row('regular')}\n${row('stranger')}\n`);
    const personas = join(dir, 'personas.yaml');
    writeFileSync(personas, 'personas:\n  - id: regular\n    goal: g\n    truth: { name: Pat Example }\n    manner: m\n    expects: none\n    callingFrom: "+15555550142"\n  - id: stranger\n    goal: g\n    truth: { name: Sam Example }\n    manner: m\n    expects: none\n');
    const calls = loadRouteCalls([join(dir, 'results.jsonl')], personas);
    expect(calls.map((x) => [x.id, x.account])).toEqual([['run-1/regular-2', true], ['run-1/stranger-2', false]]);
    expect(calls[0]!.turns).toEqual([{ who: 'line', text: 'hi' }, { who: 'caller', text: 'hello' }]);
  });

  it('reads labels and refuses a bad line', () => {
    const dir = folder('l');
    const f = join(dir, 'labels.jsonl');
    writeFileSync(f, `${JSON.stringify({ id: 'a/b-1', turn: 0, task: 'visit', drops: true })}\n`);
    expect(loadRouteLabels(f)).toEqual([{ id: 'a/b-1', turn: 0, task: 'visit', drops: true }]);
    writeFileSync(f, '{"id":"a"}\n');
    expect(() => loadRouteLabels(f)).toThrow(/line 1/);
  });
});

describe('dialogwright converse:route-eval', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  function setup() {
    const dir = join(mkdtempSync(join(tmpdir(), 'route-eval-cmd-')), 'run-1');
    mkdirSync(dir);
    dirs.push(dir);
    const app = join(dir, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'agent.yaml'), base + LEAVE_NOTE_ACTION + JOURNEYS_YAML);
    const turns = ['book me in', 'a call back please', 'what is the weather'].flatMap((t) => [{ who: 'line', text: 'How can I help?', atMs: 0 }, { who: 'caller', text: t, atMs: 1 }]);
    writeFileSync(join(dir, 'results.jsonl'), `${JSON.stringify({ persona: 'p', run: 1, call: { persona: 'p', turns, ended: true, callId: 'c' } })}\n`);
    const labels = join(dir, 'labels.jsonl');
    writeFileSync(labels, [label('run-1/p-1', 0, 'visit'), label('run-1/p-1', 1, 'note'), label('run-1/p-1', 2, 'none')].map((l) => JSON.stringify(l)).join('\n') + '\n');
    return { dir, app, calls: join(dir, 'results.jsonl'), labels };
  }
  const SAYS: Record<string, AnswerMap | 'fails'> = {
    'book me in': reading({ visit: 0.9, note: 0, none: 0.1 }),
    'a call back please': reading({ visit: 0.1, note: 0.9, none: 0 }, 0.1),
    'what is the weather': 'fails',
  };
  function fakeJev(): JevClient & { asked: JevRequest[] } {
    const asked: JevRequest[] = [];
    return {
      asked,
      async ask(req) {
        asked.push(req);
        const r = SAYS[(req.state as { said: string }).said];
        if (r === undefined || r === 'fails') throw new JevClientError('down');
        return { answers: r, model: 'fake', usage: { inputTokens: 1, outputTokens: 1, estimated: true }, latencyMs: 1, source: 'jev' };
      },
    };
  }
  const io = (dir: string, extra: { judge?: JevClient; env?: Record<string, string> }) => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l), invokedFrom: dir, env: extra.env ?? { TYPESAFE_API_KEY: 'test-value' }, ...(extra.judge !== undefined ? { judge: extra.judge } : {}) } };
  };

  it('records only what the cassette lacks, then replays with no key and no request', async () => {
    const { dir, app, calls, labels } = setup();
    const jev = fakeJev();
    const rec = io(dir, { judge: jev });
    const args = [app, '--calls', calls, '--labels', labels];
    // The third turn fails, so the recording exits 1 but reports it unanswered.
    expect(await routeEvalCommand(args, rec.io)).toBe(1);
    expect(jev.asked).toHaveLength(3);
    expect(readFileSync(routeCassettePath(labels), 'utf8').trim().split('\n')).toHaveLength(2);
    expect(rec.out.join('\n')).toContain('1 unanswered');
    expect(rec.out.join('\n')).not.toContain('book me in');
    // Recording again asks only the one it lacks.
    const jev2 = fakeJev();
    await routeEvalCommand(args, io(dir, { judge: jev2 }).io);
    expect(jev2.asked).toHaveLength(1);
    // Replay: nothing asked, a missing entry is reported unanswered.
    const again = fakeJev();
    const rep = io(dir, { env: {}, judge: again });
    expect(await routeEvalCommand([...args, '--replay', '--json'], rep.io)).toBe(1);
    expect(again.asked).toHaveLength(0);
    const json = JSON.parse(rep.out.join('\n')) as { cases: number; unanswered: number };
    expect(json.cases).toBe(3);
    expect(json.unanswered).toBe(1);
  });

  it('refuses to record in CI and without a key, and needs its options', async () => {
    const { dir, app, calls, labels } = setup();
    const args = [app, '--calls', calls, '--labels', labels];
    const ci = io(dir, { env: { CI: '1' } });
    expect(await routeEvalCommand(args, ci.io)).toBe(1);
    expect(ci.err.join('\n')).toMatch(/does not record in CI/);
    const nokey = io(dir, { env: {} });
    expect(await routeEvalCommand(args, nokey.io)).toBe(1);
    expect(nokey.err.join('\n')).toMatch(/needs the decision model's key, TYPESAFE_API_KEY/);
    expect(await routeEvalCommand(['--labels', labels], io(dir, {}).io)).toBe(2);
  });
});
