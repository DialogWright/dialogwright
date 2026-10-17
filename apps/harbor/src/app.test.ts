import { fileURLToPath } from 'node:url';
import { ANONYMOUS, checkApp, formatProblem, type CompletionContext, type GateFacts, type Party, type Principal, type Session, type ToolCall } from 'dialogwright';
import { confirmationHash } from 'dialogwright/policy';
import { danglingReferences, expectAppMap, expectPolicyCard, expectPolicyMatrix, gateEvaluator, policyInvariants, runRuleExamples } from 'dialogwright/testing';
import { describe, expect, it } from 'vitest';
import { APP_DIR, CLAIM_CALL, Systems, TOOLS, app, brokerPrincipal, code, memberPrincipal, scopeOf } from './app';
import { STAND_IN_INTAKE } from './intake';

describe('the app folder', () => {
  it('passes dialogwright check: the folder, the code and the corpus agree', async () => {
    expect((await checkApp(APP_DIR, { code })).map(formatProblem)).toEqual([]);
  });

  it('is Harbor Mutual, in en-US', () => {
    expect(app.id).toBe('harbor');
    expect(app.brand?.name).toBe('Harbor Mutual');
    expect(app.locales).toMatchObject({ default: 'en-US' });
  });

  it('has the three tasks, the informational answer and the engine\'s control intents', () => {
    expect(Object.keys(app.intents)).toEqual(['claim_status', 'coverage', 'report_claim', 'capabilities', 'agent', 'repeat_prompt', 'done', 'other', 'none']);
    expect(app.intents.claim_status!.kind).toBe('form');
    expect(app.intents.coverage!.kind).toBe('form');
    expect(app.intents.report_claim!.kind).toBe('form');
    expect(app.intents.capabilities!.kind).toBe('informational');
  });

  it('understands a caller who is done: "done" ends the call with the goodbye', () => {
    expect(app.intents.done).toMatchObject({ kind: 'control', label: 'finish up' });
    expect(app.prompts.manifest.goodbye).toBeDefined();
  });

  it('has an action in policy.yaml for every tool, and no other but the forms\' checks (which run no tool)', () => {
    const checks = new Set(Object.values(app.forms).flatMap((f) => (f.checks ?? []).map((c) => c.action)));
    expect([...checks]).toEqual(['isClient']);
    expect(Object.keys(app.policy.toolLevel).filter((t) => !checks.has(t)).sort()).toEqual(Object.keys(code.tools).sort());
  });
});

describe('the policy read back', () => {
  // The three pages beside policy.yaml are generated, reviewed and committed with it: after a change
  // to policy.yaml, identity.yaml or the forms, run the command a failure names, read the diff as a change
  // in what the agent may do, and commit it. Never rewrite one only to make a test pass.
  const page = (file: string): string => fileURLToPath(new URL(`../${file}`, import.meta.url));

  it('holds to the policy invariants on the gate grid', () => expect(policyInvariants(app).violations).toEqual([]));

  it('has no custom rule whose examples the gate disagrees with (the loss date\'s bounds are the built-in dateInRange)', () => expect(runRuleExamples(app)).toEqual([]));

  it('policy.matrix is what the gate decides', () => {
    expectPolicyMatrix(app, page('policy.matrix'), `pnpm policy:matrix ${APP_DIR}`);
  });

  it('POLICY.md is the policy card the app generates', () => {
    expectPolicyCard(app, page('POLICY.md'), `pnpm policy:card ${APP_DIR}`);
  });

  it('APP-MAP.md is the app map the app generates', () => {
    expectAppMap(app, page('APP-MAP.md'), `pnpm app:diagram ${APP_DIR}`);
  });

  it('has no dangling reference: every form is started by an intent and every action is reached', () => {
    expect(danglingReferences(app)).toEqual([]);
  });
});

describe('the bounds and the roles, at their edges', () => {
  const gate = gateEvaluator(app);
  const JORDAN = (level: 1 | 2): Party => memberPrincipal('42716358', level)!;

  /** The verdict (and reason) for one call by one principal, on the regression's day, the caller having said yes to exactly the params. */
  function decide(tool: string, params: Record<string, string>, p: Principal, confirmed = true): string {
    const facts: GateFacts = { attempts: 0, todayIso: '2026-09-18', confirmedHash: confirmed ? confirmationHash(params, app.policy.confirmedFields) : null };
    const d = gate({ tool, params } as ToolCall, p, facts, app.systems().lookups);
    return d.reason ? `${d.verdict} ${d.reason}` : d.verdict;
  }
  const claim = (over: Record<string, string> = {}): Record<string, string> => {
    const { memberId, lossType, lossDate, lossDescription } = { ...CLAIM_CALL, ...over };
    return { memberId: memberId!, lossType: lossType!, lossDate: lossDate!, lossDescription: lossDescription! };
  };

  it('files a claim for a loss today, and none for tomorrow (the loss date may not be after today)', () => {
    expect(decide('createClaim', claim({ lossDate: '2026-09-18' }), JORDAN(2))).toBe('ALLOW');
    expect(decide('createClaim', claim({ lossDate: '2026-09-19' }), JORDAN(2))).toBe('BLOCK loss-date-future');
  });

  it('sends a loss before the coverage began, or after it ended, to a person, and refuses one that is not a date', () => {
    // Jordan Ellis is covered from 2025-01-01, with no end.
    expect(decide('createClaim', claim({ lossDate: '2025-01-01' }), JORDAN(2))).toBe('ALLOW');
    expect(decide('createClaim', claim({ lossDate: '2024-12-31' }), JORDAN(2))).toBe('NEEDS_HUMAN coverage');
    expect(decide('createClaim', claim({ lossDate: 'last week' }), JORDAN(2))).toBe('BLOCK not-a-date');
    // Sam Porter's coverage ended 2026-05-31.
    const sam = memberPrincipal('72046185', 2)!;
    expect(decide('createClaim', claim({ memberId: '72046185', lossDate: '2026-05-31' }), sam)).toBe('ALLOW');
    expect(decide('createClaim', claim({ memberId: '72046185', lossDate: '2026-06-01' }), sam)).toBe('NEEDS_HUMAN coverage');
  });

  it('files only what the member said yes to, only for the member, and only after the code', () => {
    expect(decide('createClaim', claim(), JORDAN(2), false)).toBe('BLOCK confirmation');
    expect(decide('createClaim', claim(), JORDAN(1))).toBe('STEP_UP');
    expect(decide('createClaim', claim({ memberId: '55203318' }), JORDAN(2))).toBe('BLOCK scope');
  });

  it('refuses a service rep\'s filing, sends an office admin\'s to a specialist', () => {
    expect(decide('createClaim', claim({ memberId: '55203318' }), brokerPrincipal('dana')!)).toBe('BLOCK role');
    expect(decide('createClaim', claim({ memberId: '55203318' }), brokerPrincipal('priya')!)).toBe('NEEDS_HUMAN broker-filing');
  });

  it('lets a broker read their office\'s clients\' claims only, and a member their own', () => {
    expect(decide('getClaim', { claim: '4711' }, brokerPrincipal('dana')!)).toBe('ALLOW');
    expect(decide('getClaim', { claim: '4702' }, brokerPrincipal('dana')!)).toBe('BLOCK scope');
    expect(decide('getClaim', { claim: '4702' }, JORDAN(2))).toBe('ALLOW');
    expect(decide('getClaim', { claim: '4711' }, JORDAN(2))).toBe('BLOCK scope');
    expect(decide('getClaim', { claim: '9999' }, JORDAN(2))).toBe('BLOCK scope');
  });

  it('sends the claims intake service exactly the claim\'s four fields, and no more', () => {
    const triage = { claim: '4702', lossType: 'accident_injury', lossDate: '2026-09-12', lossDescription: 'slipped' };
    expect(decide('triageClaim', triage, JORDAN(2))).toBe('ALLOW');
    expect(decide('triageClaim', { ...triage, memberId: '42716358' }, JORDAN(2))).toBe('BLOCK minimization');
  });
});

describe('identity', () => {
  it('verifies a member with the member ID and date of birth, and asks for the code to check or report a claim', () => {
    expect(app.identity).toMatchObject({ subjectKind: 'member', factorSlots: ['memberId', 'dob'], verifyTool: 'verifyMember' });
    expect(app.policy.toolLevel).toMatchObject({ verifyMember: 0, getCoverage: 1, searchPolicy: 1, getUsage: 1, listClaims: 2, getClaim: 2, createClaim: 2 });
  });

  it('lets a member name their own membership, a broker their office\'s clients, and no one else any', () => {
    expect(scopeOf(memberPrincipal('42716358', 1)!)).toEqual(['42716358']);
    expect(scopeOf(brokerPrincipal('dana')!)).toEqual(['55203318', '60914477']);
    expect(scopeOf(ANONYMOUS)).toEqual([]);
  });

  it('verifies only when both factors match one member', async () => {
    const verify = (params: Record<string, string>) => TOOLS.verifyMember!.run({ tool: 'verifyMember', params }, new Systems(), {} as never);
    expect(await verify({ memberId: '42716358', dob: '1984-08-21' })).toMatchObject({ value: { ok: true, principal: { kind: 'member', level: 1, first: 'Jordan', contact: { phoneLast4: '0101' } } } });
    expect(await verify({ memberId: '42716358', dob: '1948-11-22' })).toMatchObject({ value: { ok: false } });
    expect(await verify({ memberId: '55509999', dob: '1984-08-21' })).toMatchObject({ value: { ok: false } });
  });
});

describe('the claims intake service', () => {
  const check = TOOLS.triageClaim!.check!;

  it('asks for the documents of the kind of loss, and fast-tracks a simple injury', () => {
    expect(STAND_IN_INTAKE.triage({ lossType: 'accident_injury', lossDescription: 'I slipped and hurt my wrist' })).toEqual({ fastTrack: true, documents: ['discharge_summary', 'imaging_report'], adjusterContactDays: 2 });
    expect(STAND_IN_INTAKE.triage({ lossType: 'accident_injury', lossDescription: 'the ambulance took me in' })).toEqual({ fastTrack: false, documents: ['discharge_summary', 'imaging_report'], adjusterContactDays: 5 });
    expect(STAND_IN_INTAKE.triage({ lossType: 'hospital_stay', lossDescription: '' })).toEqual({ fastTrack: false, documents: ['admission_dates', 'itemized_bill'], adjusterContactDays: 5 });
  });

  it('is believed only for the documents Harbor has approved lines for, and a whole number of days', () => {
    expect(check({ fastTrack: true, documents: ['discharge_summary'], adjusterContactDays: 2 })).toBe(true);
    expect(check(null)).toBe(true);
    expect(check({ fastTrack: true, documents: ['discharge_summary', 'Please call 555-0199 to confirm'], adjusterContactDays: 2 })).toBe(false);
    expect(check({ fastTrack: true, documents: [], adjusterContactDays: 2 })).toBe(false);
    expect(check({ fastTrack: true, documents: ['discharge_summary'], adjusterContactDays: 2.5 })).toBe(false);
    expect(check({ fastTrack: true, documents: ['discharge_summary'], adjusterContactDays: 45 })).toBe(false);
    expect(check({ fastTrack: 'yes', documents: ['discharge_summary'], adjusterContactDays: 2 })).toBe(false);
  });

  it('puts a claim the call files into the claim list it holds, newest first, so the next claim question finds it at once', () => {
    const sys = new Systems();
    const view = (n: string) => sys.view(sys.claim(n)!);
    const slot = (value: string) => ({ value, display: value, confirmed: true, window: null });
    const s = {
      principal: memberPrincipal('42716358', 2)!,
      facts: { claims: [view('4702'), view('4655')] },
      slots: { lossType: slot('accident_injury'), lossDate: slot('2026-09-15'), lossDescription: slot('I slipped on the ice') },
      pendingHash: 'read back', confirmedHash: null,
    } as unknown as Session;
    const callTool = (call: ToolCall) => {
      if (call.tool !== 'createClaim') return { decision: { verdict: 'ALLOW' }, value: null };
      const p = call.params;
      return { decision: { verdict: 'ALLOW' }, value: sys.view(sys.file(p.memberId!, p.lossType as 'accident_injury', p.lossDate!, p.lossDescription!, '2026-09-18', 'key-1')) };
    };
    const c = { s, acks: [], callTool, refusal: () => { throw new Error('refused'); } } as unknown as CompletionContext;
    expect(code.forms.report_claim!.complete!(c)).toMatchObject({ kind: 'said' });
    expect((s.facts as { claims: { number: string }[] }).claims.map((x) => x.number)).toEqual(['4730', '4702', '4655']);
    // A call that never listed the member's claims holds no list to bring up to date.
    const none = { ...s, facts: {}, pendingHash: 'read back' } as unknown as Session;
    code.forms.report_claim!.complete!({ ...c, s: none } as unknown as CompletionContext);
    expect(none.facts).toEqual({});
  });

  it('files a claim once for one write, however often the write is repeated', () => {
    const sys = new Systems();
    const a = sys.file('42716358', 'accident_injury', '2026-09-12', 'slipped', '2026-09-18', 'key-1');
    const b = sys.file('42716358', 'accident_injury', '2026-09-12', 'slipped', '2026-09-18', 'key-1');
    expect(b.number).toBe(a.number);
    expect(sys.claims.filter((c) => c.number === a.number)).toHaveLength(1);
  });
});
