import type { ToolDef, VerifyOutcome } from '../../../core/app/types';
import { replyShape as r, type ReplyCheck } from '../../../core/replyShape';
import type { ToolCall } from '../../../gate/types';
import { customerPrincipal } from './principals';
import type { AccountView, ParcelSystems, ParcelView } from './systems';

/** What each tool returns when the gate allows it. */
export interface TestkitToolValues {
  verifyCustomer: VerifyOutcome;
  verifyCode: boolean;
  sendCode: { phoneLast4: string } | null;
  getAccount: AccountView | null;
  listParcels: ParcelView[];
  getParcel: ParcelView | null;
  getWindows: { open: boolean };
  createReport: { number: string };
  /** runs after the turn, as an effect */
  notifyDepot: null;
}

export type TestkitTool = keyof TestkitToolValues;

type Run<T extends TestkitTool> = (p: ToolCall['params'], sys: ParcelSystems, ctx: Parameters<ToolDef['run']>[2]) => { value: TestkitToolValues[T]; summary: string; ref?: string };

/**
 * A tool and the params its calls carry (ToolDef.params): what `check` holds to being recorded as
 * declared, each a slot with a redact setting or a param policy.yaml's `audit:` names.
 */
function tool<T extends TestkitTool>(params: readonly string[], run: Run<T>, audit?: ToolDef['audit']): ToolDef {
  return { params, run: (call, sys, ctx) => run(call.params, sys as ParcelSystems, ctx), ...(audit ? { audit } : {}) };
}

/** The fields of a parcel the policy may withhold (ToolDef.fields). */
const PARCEL_FIELDS = ['safePlace'] as const;

/**
 * What the parcel system's reply must look like where a line says it or a call is made from it
 * (ToolDef.check): a reply that does not is never used, and the caller goes to a person.
 */
const PARCEL = r.object({
  number: r.digits(4),
  item: r.text({ words: 6 }),
  status: r.oneOf(['in_transit', 'out_for_delivery', 'delivered', 'held']),
  day: r.isoDate(),
  safePlace: r.nullable(r.text({ words: 10 })),
});

function checked(def: ToolDef, check: ReplyCheck): ToolDef {
  return { ...def, check };
}

function withFields(def: ToolDef, fields: readonly string[]): ToolDef {
  return { ...def, fields };
}

/** Example Parcels' tools, each run against the in-memory systems once the gate has allowed the call. */
export const TESTKIT_TOOLS: { readonly [T in TestkitTool]: ToolDef } = {
  // A match names the account every later call is made for: its id has the account ID's form.
  verifyCustomer: checked(tool<'verifyCustomer'>(['accountId', 'dob'], (p, sys) => {
    const c = sys.verify(p.accountId ?? '', p.dob ?? '');
    return c ? { value: { ok: true, principal: customerPrincipal(c, 1) }, summary: 'verified' } : { value: { ok: false }, summary: 'no match' };
  }, ({ summary, after }) => [{ type: 'identity', detail: { factor: 'account_id_dob', pass: summary === 'verified', level: after.principal.level } }]), r.any(r.object({ ok: r.oneOf([false]) }), r.object({ ok: r.oneOf([true]), principal: r.object({ id: r.digits(8) }) }))),
  verifyCode: tool<'verifyCode'>([], (_p, _sys, { tc, code }) => {
    const ok = code !== undefined && tc.tools.codes.check(code);
    return { value: ok, summary: ok ? 'code accepted' : 'code rejected' };
  }, ({ summary, after }) => [{ type: 'identity', detail: { factor: 'one_time_code', pass: summary === 'code accepted', level: after.principal.level } }]),
  sendCode: checked(tool<'sendCode'>(['accountId'], (p, sys) => {
    const sent = sys.sendText(p.accountId ?? '', 'one_time_code');
    return { value: sent, summary: sent ? `texted ...${sent.phoneLast4}` : 'no phone on record' };
  }), r.nullable(r.object({ phoneLast4: r.digits(4) }))),
  getAccount: checked(tool<'getAccount'>(['accountId'], (p, sys) => {
    const a = sys.account(p.accountId ?? '');
    return { value: a, summary: a ? 'account found' : 'no account' };
  }), r.nullable(r.object({ id: r.digits(8), first: r.text({ words: 4, chars: 40 }), depotId: r.code() }))),
  // The whole parcel, safe place and all: what a party acting for customers may not see of it is
  // the policy's (policy.yaml redact), and the engine withholds it.
  listParcels: checked(withFields(tool<'listParcels'>(['accountId'], (p, sys) => {
    const list = sys.listParcels(p.accountId ?? '');
    return { value: list, summary: `${list.length} parcel${list.length === 1 ? '' : 's'}` };
  }), PARCEL_FIELDS), r.list(PARCEL)),
  getParcel: checked(withFields(tool<'getParcel'>(['parcel'], (p, sys) => {
    const v = sys.getParcel(p.parcel ?? '');
    return { value: v, summary: v ? v.status : 'not found' };
  }), PARCEL_FIELDS), r.nullable(PARCEL)),
  getWindows: tool<'getWindows'>(['accountId', 'deliveryDay', 'deliveryPart'], (p, sys) => {
    const open = sys.windowOpen(p.deliveryDay ?? '', p.deliveryPart ?? '');
    return { value: { open }, summary: open ? 'window open' : 'window full' };
  }),
  // A write: idempotent, so the systems file one report for the same confirmed write however often it runs.
  createReport: { ...tool<'createReport'>(['accountId', 'missingNote', 'expectedDate'], (p, sys, { idempotencyKey }) => {
    const report = sys.createReport({ owner: p.accountId ?? '', missingNote: p.missingNote ?? '', expectedDate: p.expectedDate ?? '' }, idempotencyKey);
    return { value: { number: report.number }, summary: `report ${report.number}`, ref: report.number };
  }, ({ call, ref }) => [{ type: 'report_created', detail: { report: ref ?? null, customer: call.params.accountId ?? null } }]), idempotent: true, check: r.object({ number: r.digits(4) }) },
  notifyDepot: tool<'notifyDepot'>(['report', 'missingNote', 'expectedDate'], (p, _sys, { out }) => {
    // The one hop to another agent: queued as an effect, made after the turn.
    out.effects.push({ kind: 'service', service: 'depot', params: { ...p } });
    return { value: null, summary: 'sent to the depot agent' };
  }, ({ call }) => [{ type: 'a2a', detail: { agent: 'depot', phase: 'sent', fieldsSent: Object.keys(call.params) } }]),
};
