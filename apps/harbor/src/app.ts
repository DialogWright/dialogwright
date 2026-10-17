import { fileURLToPath } from 'node:url';
import {
  defineApp, describeDay, handoff, kbAnswerTool, localeOf, replyShape as r,
  type Ack, type AppCode, type Completion, type CompletionContext, type Party, type Principal, type Session, type ToolDef, type VerifyOutcome,
} from 'dialogwright';
import {
  AGENT_OF_RECORD, BROKERS, CLAIMS, DOCUMENT_CODES, FIRST_NEW_CLAIM, MEMBERS, SERVICES, USAGE,
  brokerOf, last4, memberOf, type Claim, type ClaimStatus, type DocumentCode, type LossType,
} from './data';
import { STAND_IN_INTAKE, type IntakeService, type IntakeTriage } from './intake';
import { portalPages } from './portal';

/**
 * Harbor Mutual, built from its folder. The YAML next to this src/ folder holds what is data: what a
 * caller can ask for, the forms' slots and summaries, every line the caller hears, the gate's rules,
 * how a caller proves who they are, and the knowledge base (kb/). This file holds what runs: the
 * tools over the insurer's systems (a stub here), the hooks of each form, and the gate's lookups.
 * Policy is never in a tool: the gate decides, from policy.yaml, whether a tool may run.
 */

/** The app's folder: the one with app.yaml, above this src/. */
export const APP_DIR = fileURLToPath(new URL('..', import.meta.url));

/** A text sent to the phone on file: the one-time code, or the link to upload a claim's documents. */
export interface TextMessage {
  memberId: string;
  kind: 'one_time_code' | 'upload_link';
  /** The claim an upload link is for. */
  claim: string | null;
  /** The write's idempotency key, where the call had one: a repeat with the same key sends nothing. */
  key: string | null;
}

/**
 * A claim as the claims system shows it to whoever asks: what a broker may not see of it (the
 * diagnosis, the member's own words) is the policy's (policy.yaml `redact`), and the engine sets
 * those fields to null for a broker before anything reads the value.
 */
export interface ClaimView {
  number: string;
  memberId: string;
  /** The member's first name and last initial ("Margaret H."), said to a broker. */
  member: string;
  type: LossType;
  service: string;
  serviceDate: string;
  receivedDate: string;
  status: ClaimStatus;
  amount: string | null;
  decisionDays: number;
  missing: DocumentCode | null;
  diagnosis: string | null;
  statement: string | null;
}

/**
 * The insurer's systems for one call (App.systems builds a fresh one per call): a stub over the
 * fixture data, holding the claims filed and the texts sent so far, and the claims intake service.
 * The real clients replace it; keep the tests on it.
 */
export class Systems {
  readonly claims: Claim[] = CLAIMS.map((c) => ({ ...c }));
  /** Every text this stub "sent": it sends nothing, so this is the record a test reads. */
  readonly outbox: TextMessage[] = [];
  /** Claims filed on the call, by the write's idempotency key: a repeated write files nothing new. */
  private readonly filed = new Map<string, string>();
  private next = FIRST_NEW_CLAIM;
  constructor(readonly intake: IntakeService = STAND_IN_INTAKE) {}

  claim(number: string): Claim | undefined {
    return this.claims.find((c) => c.number === number);
  }

  view(c: Claim): ClaimView {
    const m = memberOf(c.memberId);
    return {
      number: c.number, memberId: c.memberId, member: m ? `${m.first} ${m.last[0]}.` : '', type: c.type, service: c.service,
      serviceDate: c.serviceDate, receivedDate: c.receivedDate, status: c.status, amount: c.amount, decisionDays: c.decisionDays,
      missing: c.missing, diagnosis: c.diagnosis, statement: c.statement,
    };
  }

  /** Files a claim; the same idempotency key again answers with the claim it filed the first time. */
  file(memberId: string, type: LossType, lossDate: string, statement: string, todayIso: string, key: string | null): Claim {
    const already = key === null ? undefined : this.filed.get(key);
    if (already !== undefined) return this.claim(already)!;
    const service = type === 'hospital_stay' ? 'hospital stay' : type === 'diagnosis' ? 'covered diagnosis' : 'accident injury';
    const claim: Claim = {
      number: String(this.next++), memberId, type, service, serviceDate: lossDate, receivedDate: todayIso,
      status: 'received', diagnosis: '', amount: null, decisionDays: 10, missing: null, statement,
    };
    this.claims.push(claim);
    if (key !== null) this.filed.set(key, claim.number);
    return claim;
  }

  /** Texts the member at the phone on file; null for no such member. A repeat of a keyed text sends nothing new. */
  text(memberId: string, kind: TextMessage['kind'], claim: string | null, key: string | null): { phoneLast4: string } | null {
    const m = memberOf(memberId);
    if (!m) return null;
    if (key === null || !this.outbox.some((t) => t.key === key)) this.outbox.push({ memberId, kind, claim, key });
    return { phoneLast4: last4(m.phone) };
  }
}

/** What the app keeps on the session: the member's claims, as the claim_status form's entry call read them. */
interface Facts {
  claims?: ClaimView[];
}

/**
 * The member a call is about. A member's is the one they verified or signed in as (the principal's
 * id, never a value said later); a caller not yet verified has only what they said for the factor,
 * which the gate's scope rule refuses until they are verified.
 */
export const memberIdOf = (s: Session): string => (s.principal.kind === 'member' ? s.principal.id : s.slots.memberId?.value ?? '');

/** A member, as the verify tool and a member-portal sign-in prove them. */
export function memberPrincipal(id: string, level: 1 | 2): Party | null {
  const m = memberOf(id);
  return m ? { kind: 'member', level, id: m.id, first: m.first, contact: { phoneLast4: last4(m.phone) } } : null;
}

/** A broker, as the broker portal signs them in: at the top level, with their role and their office. */
export function brokerPrincipal(id: string): Party | null {
  const b = brokerOf(id);
  return b ? { kind: 'broker', level: 2, id: b.id, first: b.first, name: b.name, role: b.role, attrs: { officeId: b.officeId } } : null;
}

/** The members a principal may see: a member their own, a broker their office's clients (agent of record), anyone else none. */
export function scopeOf(p: Principal): readonly string[] {
  if (p.level === 0) return [];
  if (p.kind === 'member') return [p.id];
  if (p.kind === 'broker') return AGENT_OF_RECORD[(p as Party).attrs?.officeId ?? ''] ?? [];
  return [];
}

/** A member's coverage window, for the gate's `dateInRange` rule (`coverageWindow(memberId)`); null for no coverage on file. */
export function coverageWindow(memberId: string): { start: string; end: string | null } | null {
  const m = memberOf(memberId);
  return m ? { start: m.coverageFrom, end: m.coverageTo } : null;
}

/** The statuses a claim may have, and the claim as a line says it: every field a line says or a call is made from. */
const STATUSES: readonly ClaimStatus[] = ['received', 'in_review', 'approved', 'paid', 'needs_info'];
const CLAIM = r.object({
  number: r.digits(4),
  member: r.text({ words: 3, chars: 40 }),
  service: r.oneOf([...SERVICES]),
  serviceDate: r.isoDate(),
  receivedDate: r.isoDate(),
  status: r.oneOf([...STATUSES]),
  amount: r.nullable(r.amount()),
  decisionDays: r.number({ min: 1, max: 90 }),
  missing: r.nullable(r.oneOf([...DOCUMENT_CODES])),
});

/** The intake service's triage as the lines may say it: known document codes only, at least one, and a whole number of days. */
const TRIAGE = r.nullable(r.all(
  r.object({ fastTrack: r.boolean(), documents: r.list(r.oneOf([...DOCUMENT_CODES])), adjusterContactDays: r.number({ min: 1, max: 30 }) }),
  (v) => Array.isArray((v as { documents?: unknown }).documents) && (v as { documents: unknown[] }).documents.length > 0
    && Number.isInteger((v as { adjusterContactDays?: unknown }).adjusterContactDays),
));

/** The fields of a claim the policy may withhold from a broker (policy.yaml `redact`). */
const CLAIM_FIELDS = ['diagnosis', 'statement'] as const;

/**
 * Every tool, by name; each has an action in policy.yaml, and policy.yaml names no other. `params` is
 * what its calls carry: policy.yaml's `audit` says how each is recorded (the slots' redact settings
 * cover the member ID, the date of birth and the member's description). A reply comes from the
 * insurer's systems and is not trusted: each tool whose reply a line says, or a call is made from,
 * checks its shape (`check`).
 */
export const TOOLS: Record<string, ToolDef> = {
  // Checks the member ID and date of birth. A match is the member at level 1.
  verifyMember: {
    params: ['memberId', 'dob'],
    run(call) {
      const m = MEMBERS.find((x) => x.id === call.params.memberId && x.dob === call.params.dob);
      const principal = m ? memberPrincipal(m.id, 1) : null;
      const value: VerifyOutcome = principal ? { ok: true, principal } : { ok: false };
      return { value, summary: principal ? 'verified' : 'no match' };
    },
    // A match names the member every later call is made for: its id has the member ID's form.
    check: r.any(r.object({ ok: r.oneOf([false]) }), r.object({ ok: r.oneOf([true]), principal: r.object({ id: r.digits(8) }) })),
  },
  // Texts a one-time code to the phone on file; the line says its last four.
  sendCode: {
    params: ['memberId'],
    run(call, sys) {
      const sent = (sys as Systems).text(call.params.memberId ?? '', 'one_time_code', null, null);
      return { value: sent, summary: sent ? `texted ...${sent.phoneLast4}` : 'no phone on record' };
    },
    check: r.nullable(r.object({ phoneLast4: r.digits(4) })),
  },
  // Checks the one-time code with the engine's verifier (a mock in tests: an even last digit passes).
  verifyCode: {
    params: [],
    run(_call, _sys, { tc, code }) {
      const ok = code !== undefined && tc.tools.codes.check(code);
      return { value: ok, summary: ok ? 'code accepted' : 'code rejected' };
    },
  },
  // The member's plan and coverage dates: the coverage and report forms' entry call.
  getCoverage: {
    params: ['memberId'],
    run(call) {
      const m = memberOf(call.params.memberId ?? '');
      return { value: m ? { plan: m.plan, from: m.coverageFrom, to: m.coverageTo } : null, summary: m ? m.plan : 'no coverage' };
    },
    check: r.nullable(r.object({ plan: r.oneOf(['advantage', 'advantage_plus']), from: r.isoDate(), to: r.nullable(r.isoDate()) })),
  },
  // The answer from the member's own plan certificate: the approved passage in force today for the
  // topic and the member's plan, read from the member's record (never from what the caller said).
  searchPolicy: kbAnswerTool({
    subject: 'memberId',
    facts: (params) => {
      const m = memberOf(params.memberId ?? '');
      return m ? { plan: m.plan } : null;
    },
  }),
  // This year's use of a benefit, for the line after its answer (kb/topics.yaml accountLine): the
  // count is the member's own record, said to them and never put in the summary.
  getUsage: {
    params: ['memberId', 'topic'],
    fields: ['used'],
    run(call) {
      const id = call.params.memberId ?? '';
      if (!memberOf(id)) return { value: null, summary: 'no usage on record' };
      return { value: { used: USAGE[id]?.[call.params.topic ?? ''] ?? 0 }, summary: 'usage read' };
    },
    check: r.nullable(r.object({ used: r.number({ min: 0, max: 366 }) })),
  },
  // The member's claims, newest first: the claim_status form's entry call.
  listClaims: {
    params: ['memberId'],
    fields: CLAIM_FIELDS,
    run(call, sys) {
      const s = sys as Systems;
      const list = s.claims
        .filter((c) => c.memberId === call.params.memberId)
        .sort((a, b) => (a.serviceDate === b.serviceDate ? b.number.localeCompare(a.number) : b.serviceDate.localeCompare(a.serviceDate)))
        .map((c) => s.view(c));
      return { value: list, summary: `${list.length} claim${list.length === 1 ? '' : 's'}` };
    },
    check: r.list(CLAIM),
  },
  // One claim, by number. The summary is its status: what the policy withheld from a broker the engine adds.
  getClaim: {
    params: ['claim'],
    fields: CLAIM_FIELDS,
    run(call, sys) {
      const s = sys as Systems;
      const c = s.claim(call.params.claim ?? '');
      return c ? { value: s.view(c), summary: c.status } : { value: null, summary: 'not found' };
    },
    check: r.nullable(CLAIM),
  },
  // Files the claim the member said yes to. The gate has already checked the level, the role, whose
  // it is, that the values are exactly the ones read back, and the loss date's bounds.
  createClaim: {
    params: ['memberId', 'lossType', 'lossDate', 'lossDescription'],
    fields: CLAIM_FIELDS,
    idempotent: true,
    run(call, sys, { tc, idempotencyKey }) {
      const s = sys as Systems;
      const p = call.params;
      const c = s.file(p.memberId ?? '', (p.lossType ?? '') as LossType, p.lossDate ?? '', p.lossDescription ?? '', tc.todayIso, idempotencyKey ?? null);
      return { value: s.view(c), summary: `claim ${c.number}`, ref: c.number };
    },
    // The claim number is said to the member, and the triage and the upload link are made from it.
    check: CLAIM,
  },
  // Hands the filed claim to the claims intake service and returns its triage. Its reply is never
  // repeated: only the document codes Harbor has approved lines for, the days and the fast-track
  // flag pass the check, and a reply that does not is taken as no answer (the form calls it failSoft).
  triageClaim: {
    params: ['claim', 'lossType', 'lossDate', 'lossDescription'],
    run(call, sys) {
      const triage = (sys as Systems).intake.triage({ ...call.params });
      return { value: triage ?? null, summary: triage ? 'triaged by the intake service' : 'no triage' };
    },
    check: TRIAGE,
  },
  // Texts the link to upload a filed claim's documents to the phone on file of the claim's member.
  sendUploadLink: {
    params: ['claim'],
    idempotent: true,
    run(call, sys, { idempotencyKey }) {
      const s = sys as Systems;
      const owner = s.claim(call.params.claim ?? '')?.memberId;
      const sent = owner ? s.text(owner, 'upload_link', call.params.claim ?? null, idempotencyKey ?? null) : null;
      return { value: sent, summary: sent ? `texted ...${sent.phoneLast4}` : 'no phone on record' };
    },
    check: r.nullable(r.object({ phoneLast4: r.digits(4) })),
  },
};

/** A claim's amount as the line says it, in dollars: "300" for 300.00, "312.50" otherwise. */
export const dollars = (amount: string): string => amount.replace(/\.00$/, '');

/** The status line for a claim, by its status, and by whether a member or a broker asks. */
export function statusPromptId(view: ClaimView, broker: boolean): string {
  const base = view.status === 'approved' && view.amount === null ? 'claim_status_approved_no_amount' : `claim_status_${view.status}`;
  return broker ? `${base}_broker` : base;
}

/** The claim_status form: read the claim chosen through the gate (the scope rule decides whose), and say its status. */
function completeClaimStatus(c: CompletionContext): Completion {
  const { s, acks } = c;
  const { decision, value, redacted } = c.callTool({ tool: 'getClaim', params: { claim: s.slots.claimSelect?.value ?? '' } });
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  if (value === null) return { kind: 'refused', acks: [...acks, { promptId: scopeLine(s.principal), vars: {} }] };
  const view = value as ClaimView;
  const locale = localeOf(s);
  const vars = {
    claim: view.number, member: view.member, service: view.service, serviceDate: describeDay(view.serviceDate, locale),
    receivedDate: describeDay(view.receivedDate, locale), days: String(view.decisionDays), amount: view.amount === null ? '' : dollars(view.amount),
  };
  const broker = s.principal.kind === 'broker';
  const lines: Ack[] = [{ promptId: statusPromptId(view, broker), vars }];
  // The document a claim waits on is said by its approved line, then where to upload it.
  if (view.status === 'needs_info' && view.missing !== null) {
    lines.push({ promptId: `doc_${view.missing}`, vars: {} }, { promptId: broker ? 'claim_upload_broker' : 'claim_upload', vars: {} });
  }
  // A broker hears that the medical details were withheld, when the policy withheld them.
  if (redacted?.includes('diagnosis')) lines.push({ promptId: 'broker_redaction_note', vars: {} });
  return { kind: 'said', acks: [...acks, ...lines] };
}

/** What a claim filed on the call writes: whose it is and what the member heard read back and said yes to. */
const reportParams = (s: Session): { memberId: string; lossType: string; lossDate: string; lossDescription: string } => ({
  memberId: memberIdOf(s),
  lossType: s.slots.lossType?.value ?? '',
  lossDate: s.slots.lossDate?.value ?? '',
  lossDescription: s.slots.lossDescription?.value ?? '',
});

/**
 * The report_claim form is full and confirmed: file the claim through the gate, then hand it to the
 * claims intake service and say what it needs in the approved lines, with the upload link texted.
 */
function completeReport(c: CompletionContext): Completion {
  const { s, acks } = c;
  const params = reportParams(s);
  s.confirmedHash = s.pendingHash;
  const { decision, value } = c.callTool({ tool: 'createClaim', params });
  s.confirmedHash = null;
  if (decision.verdict === 'BLOCK' && decision.reason === 'confirmation') return { kind: 'reconfirm', acks };
  // A loss date outside the member's coverage goes to a claims specialist, with its own line.
  if (decision.verdict === 'NEEDS_HUMAN' && decision.reason === 'coverage') return { kind: 'decision', decision: handoff(s, 'coverage', acks) };
  if (decision.verdict !== 'ALLOW') return c.refusal(decision);
  s.pendingHash = null;
  const claim = (value as ClaimView).number;
  const lines: Ack[] = [{ promptId: 'claim_filed', vars: { claim } }];
  // The intake service's triage. Called failSoft: a service that is down, or a reply that fails its
  // check, is no answer, and the member hears that an adjuster will be in touch.
  const triage = c.callTool(
    { tool: 'triageClaim', params: { claim, lossType: params.lossType, lossDate: params.lossDate, lossDescription: params.lossDescription } },
    { failSoft: true },
  );
  const answer = triage.decision.verdict === 'ALLOW' && triage.failed !== true ? (triage.value as IntakeTriage | null) : null;
  if (answer === null) return { kind: 'said', acks: [...acks, ...lines, { promptId: 'intake_unavailable', vars: {} }] };
  const link = c.callTool({ tool: 'sendUploadLink', params: { claim } });
  const texted = link.decision.verdict === 'ALLOW' && link.value !== null;
  if (answer.fastTrack) lines.push({ promptId: 'intake_fast_track', vars: {} });
  lines.push({ promptId: texted ? 'intake_documents_texted' : 'intake_documents', vars: {} });
  for (const doc of new Set<DocumentCode>(answer.documents)) lines.push({ promptId: `doc_${doc}`, vars: {} });
  lines.push({ promptId: 'intake_adjuster', vars: { days: String(answer.adjusterContactDays) } });
  return { kind: 'said', acks: [...acks, ...lines] };
}

/** The scope refusal's line, in the terms of who asked: a member's own claims, or a broker's office's clients. */
const scopeLine = (p: Principal): string => (p.kind === 'broker' ? 'claim_blocked_scope_broker' : 'claim_blocked_scope');

/** The refusal line for each reason the gate blocks with; null sends the caller to a person. */
export function blockPromptId(reason: string | undefined, p: Principal): string | null {
  switch (reason) {
    case 'scope': return scopeLine(p);
    case 'role': return 'claim_blocked_role';
    case 'loss-date-future': return 'loss_date_future';
    default: return null;
  }
}

/** A sample claim filed by Jordan Ellis, inside every bound on the regression's day (2026-09-18). */
export const CLAIM_CALL: Readonly<Record<string, string>> = {
  memberId: '42716358', lossType: 'accident_injury', lossDate: '2026-09-12', lossDescription: 'I slipped on the ice and hurt my wrist',
  claim: '4702', topic: 'physical_therapy', dob: '1984-08-21',
};

/** The claim CLAIM_CALL files: exactly the confirmed fields the write sends. */
const CLAIM_WRITE: Readonly<Record<string, string>> = {
  memberId: CLAIM_CALL.memberId!, lossType: CLAIM_CALL.lossType!, lossDate: CLAIM_CALL.lossDate!, lossDescription: CLAIM_CALL.lossDescription!,
};

/** The app's TypeScript parts: everything the YAML names that runs. */
export const code: AppCode = {
  // Every slot is a library type in slots.yaml.
  slots: {},
  tools: TOOLS,
  lookups: ['coverageWindow'],
  systems: () => {
    const sys = new Systems();
    return {
      sys,
      lookups: { ownerOf: (n: string) => sys.claim(n)?.memberId ?? null, scopeOf, coverageWindow: (id: string) => coverageWindow(id) },
    };
  },
  blockPromptId,
  identity: { sendCodeParams: (s) => ({ memberId: memberIdOf(s) }) },
  principals: {
    subjectPrincipal: memberPrincipal,
    delegatePrincipal: brokerPrincipal,
    // A token from the broker portal names the broker (`broker_id`); a member's names the member
    // (`sub`, through subjectPrincipal at the sign-in level).
    fromClaims: (claims) => (typeof claims.broker_id === 'string' ? brokerPrincipal(claims.broker_id) : null),
  },
  portal: {
    subjects: () => MEMBERS.map((m) => ({ id: m.id, first: m.first, last: m.last })),
    delegates: () => BROKERS.map((b) => ({ id: b.id, name: b.name, role: b.role, attrs: { office: b.office, officeId: b.officeId } })),
    roleLabel: (role) => (role === 'office_admin' ? 'office administrator' : 'service rep'),
  },
  // The demo portal (src/portal.ts): served at /harbor/portal only with HARBOR_DEMO_PORTAL=on.
  pages: portalPages,
  facts: {
    initial: () => ({}),
    clone: (f) => ({ ...(f as Facts), ...((f as Facts).claims ? { claims: [...(f as Facts).claims!] } : {}) }),
    onFormClosed: (f) => { delete (f as Facts).claims; },
    forSlots: (f) => ({ sources: { claims: (f as Facts).claims ?? [] } }),
  },
  forms: {
    claim_status: {
      // Needs level 2: an anonymous caller verifies and keys the code before anything else.
      entry: (s) => ({ tool: 'listClaims', params: { memberId: memberIdOf(s) } }),
      // The member's claims, for the slot to choose among; one claim is the one they mean.
      onEntry: (s, value) => {
        const claims = Array.isArray(value) ? (value as ClaimView[]) : [];
        (s.facts as Facts).claims = claims;
        const [only] = claims;
        const slot = s.slots.claimSelect;
        if (claims.length === 1 && only && slot && slot.value === null) {
          Object.assign(slot, { value: only.number, display: only.number, confirmed: true, window: null });
        }
      },
      // A broker names the claim: the form asks for it, and the scope rule decides.
      principalEntry: () => null,
      complete: completeClaimStatus,
    },
    // A form that answers from the knowledge base has no `complete` of its own (the engine's
    // knowledge completion says the answer): its hooks are the two forms.yaml lists.
    coverage: {
      // Needs level 1: the answer is the member's own plan's, so a caller verifies first.
      entry: (s) => ({ tool: 'getCoverage', params: { memberId: memberIdOf(s) } }),
      // A broker makes no entry call of a member's own: the form asks which client (clientId, asked of
      // brokers only), the gate checks the office is that member's agent of record (forms.yaml's
      // isClient check), and the answer is read for that member (answers.subject).
      principalEntry: () => null,
    },
    report_claim: {
      // Needs level 2 (the purpose in policy.yaml): the code is keyed before the form's questions.
      entry: (s) => ({ tool: 'getCoverage', params: { memberId: memberIdOf(s) }, purpose: 'report_claim' }),
      // A broker hears the role rule's answer before any question: a service rep may not file (its
      // line), an office admin's filing goes to a claims specialist.
      principalEntry: (c) => {
        const { decision } = c.callTool({ tool: 'createClaim', params: {}, purpose: 'entry-check' });
        if (decision.verdict === 'NEEDS_HUMAN') return handoff(c.s, decision.reason ?? 'needs-human', c.acks);
        if (decision.verdict === 'BLOCK' && decision.reason === 'role') return { kind: 'refused', acks: [...c.acks, { promptId: 'claim_blocked_role', vars: {} }] };
        return null;
      },
      confirmedParams: reportParams,
      complete: completeReport,
    },
  },
  // What the regression harness and the stub clients need (never used on a live call).
  testing: {
    // What `pnpm cli --client heuristic` listens for, in the order the first match wins.
    heuristics: {
      intents: [
        ['report_claim', /\b(report|file|new claim|broke|hurt|injur\w*|accident)\b/],
        ['claim_status', /\b(status|claim|paid)\b/],
        ['coverage', /\b(cover\w*|benefit|pay for|plan)\b/],
        ['capabilities', /\b(what can you do|options|robot)\b/],
      ],
    },
    seed: {
      // A seeded form is one a verified member is in the middle of, at the top level (claims need the code).
      caller: () => memberPrincipal(MEMBERS[0]!.id, 2)!,
      placeholders: {
        memberId: { value: MEMBERS[0]!.id, display: '4271 6358' },
        dob: { value: MEMBERS[0]!.dob, display: 'August 21st, 1984' },
        claimSelect: { value: '4702', display: '4702' },
        coverageTopic: { value: 'physical_therapy', display: 'physical therapy after an accident' },
        lossType: { value: 'accident_injury', display: 'an accident injury' },
        lossDate: { value: '2026-09-12', display: 'Saturday, September 12th' },
        lossDescription: { value: 'I slipped on the ice and hurt my wrist', display: 'your description' },
      },
      // A corpus line at "anything else?" follows a claim's status, read through the gate.
      anythingElse: () => ({ form: 'claim_status', call: { tool: 'getClaim', params: { claim: '4702' } } }),
    },
    // A corpus line answering the offer of a person (after an answer that could not be given) is seeded in the coverage form.
    offerTransferForm: 'coverage',
    // The callers and members the gate grid crosses with every action, for the policy read back.
    policyMatrix: () => ({
      principals: {
        subject1: memberPrincipal(MEMBERS[0]!.id, 1)!,
        subject2: memberPrincipal(MEMBERS[0]!.id, 2)!,
        delegates: { service_rep: brokerPrincipal('dana')!, office_admin: brokerPrincipal('priya')! },
        unlistedRole: { kind: 'broker', level: 2, id: 'quinn', first: 'Quinn', role: 'assistant', attrs: { officeId: 'LB-01' } },
        roleless: { kind: 'broker', level: 2, id: 'rowan', first: 'Rowan', attrs: { officeId: 'LB-01' } },
        otherParty: { kind: 'visitor', level: 2, id: 'V-1', first: 'Robin' },
      },
      // Jordan's own claim, Margaret's (a client of Lakeside Benefits), Sam Porter's (a member of no
      // office's book here), and one that does not exist.
      records: {
        own: { subject: '42716358', record: '4702' },
        inScope: { subject: '55203318', record: '4711' },
        outOfScope: { subject: '72046185', record: '4690' },
        unknown: { subject: '55500000', record: '4999' },
      },
      values: CLAIM_CALL,
      // createClaim's dateInRange reads the loss date: a day inside Jordan's coverage, one before it
      // began (a person), and one after today (refused).
      calls: {
        createClaim: {
          covered: CLAIM_WRITE,
          beforeCoverage: { ...CLAIM_WRITE, lossDate: '2024-12-31' },
          tomorrow: { ...CLAIM_WRITE, lossDate: '2026-09-19' },
        },
      },
    }),
  },
};

/** The app: the folder joined with the code above. */
export const app = defineApp(APP_DIR, code, { codeFile: 'src/app.ts' });
