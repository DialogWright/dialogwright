import type { App, CallDataKey, FormId, SlotId, TransferConfig, TransferSend } from './app/types';
import { allHold, alwaysHolds, conditionProblems, conditionRefProblems, CONDITION_SHAPES, type Condition, type ConditionFacts, type ConditionWorld } from './conditions';
import { envVariableOf } from './app/envReference';
import { callDataSourceOf, recordedCallData, redactionOf, writableValue } from '../channel/callData';
import { floorByName } from '../channel/maskByName';

/**
 * Transfer targets and the data sent with a transfer (app.yaml's `transfer`, App.transfer): the engine
 * chooses, the server dials. At a handoff the rules are tried in order and the first whose conditions
 * all hold is taken (core/conditions.ts), else the default; the choice is the environment variable that
 * holds the number (never the number), which travels on the transfer action and the end frame's handoff
 * data to the server, which dials its value (server/transfer.ts). What goes with it (`send`) is resolved
 * here, from the session, as the records would have it: a call data key by its `redact`, a slot as the
 * handoff data sends it. An app without `transfer` chooses nothing, and every handoff is as before.
 */

/** A value of `send` as written, read: a reference to what the call has, or a constant. */
export type TransferValue =
  | { readonly kind: 'reason' }
  | { readonly kind: 'form' }
  | { readonly kind: 'callData'; readonly key: string }
  | { readonly kind: 'slot'; readonly slot: SlotId }
  | { readonly kind: 'constant'; readonly value: string };

/** `reason`, `form`, `callData.<key>` or `slot.<id>` is a reference; anything else is a constant, sent as written. */
export function transferValueOf(raw: string): TransferValue {
  if (raw === 'reason') return { kind: 'reason' };
  if (raw === 'form') return { kind: 'form' };
  if (raw.startsWith('callData.') && raw.length > 'callData.'.length) return { kind: 'callData', key: raw.slice('callData.'.length) };
  if (raw.startsWith('slot.') && raw.length > 'slot.'.length) return { kind: 'slot', slot: raw.slice('slot.'.length) };
  return { kind: 'constant', value: raw };
}

/**
 * A SIP header name a transfer may send: an `X-` header, or `User-to-User`, the two every carrier this
 * engine speaks documents for a `<Dial><Sip>` (Twilio: "Any headers starting with the x- prefix", and
 * User-to-User without it). Letters, digits and hyphens after the `X-`.
 */
export const HEADER_NAME = /^(?:[Xx]-[A-Za-z0-9][A-Za-z0-9-]*|[Uu]ser-[Tt]o-[Uu]ser)$/;

/** A key of a chat transfer's `data`: a plain word. */
export const CHAT_DATA_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The longest a constant may be: a custom parameter's (the wire's limit, channel/callData.ts). */
export const TRANSFER_CONSTANT_MAX = 500;

/** Headers the Telnyx platform reserves (its custom header article: `X-Telnyx` names are stripped from webhooks and used for its own sign-in). */
const RESERVED_HEADER = /^x-telnyx/i;

/** What the engine chose for a handoff: the target's variable, the rule taken, and what goes with it. */
export interface TransferChoice {
  /** The environment variable holding the number or SIP URI dialed (`HANDOFF_NUMBER` for `env.HANDOFF_NUMBER`). */
  readonly target: string;
  /** The rule taken, by its index in `targets`; null for the default. */
  readonly rule: number | null;
  /** The SIP headers resolved, by name; absent when there are none. */
  readonly headers?: Readonly<Record<string, string>>;
  /** A chat transfer's data, by key; absent when there is none. */
  readonly data?: Readonly<Record<string, string>>;
}

/** The send a rule (or the default, null) goes with: its own over the top-level one, by name. */
export function sendOf(transfer: TransferConfig, rule: number | null): TransferSend {
  const own = rule === null ? undefined : transfer.targets[rule]?.send;
  const top = transfer.send;
  // A SIP header's name is not case-sensitive: a rule's `x-reason` replaces the top-level `X-Reason`
  // (written as the rule spells it, where the top-level one stood), never sent beside it.
  const headers: Record<string, string> = { ...(top?.headers ?? {}) };
  for (const [name, value] of Object.entries(own?.headers ?? {})) {
    const same = Object.keys(headers).find((n) => n.toLowerCase() === name.toLowerCase());
    if (same === undefined || same === name) headers[name] = value;
    else {
      const merged = Object.entries(headers).map(([n, v]): [string, string] => (n === same ? [name, value] : [n, v]));
      for (const n of Object.keys(headers)) delete headers[n];
      Object.assign(headers, Object.fromEntries(merged));
    }
  }
  const chat = { ...(top?.chat ?? {}), ...(own?.chat ?? {}) };
  return { ...(Object.keys(headers).length > 0 ? { headers } : {}), ...(Object.keys(chat).length > 0 ? { chat } : {}) };
}

/** The rule a handoff with these facts takes: the first whose `when` all holds, else null (the default). */
export function ruleTaken(transfer: TransferConfig, facts: ConditionFacts): number | null {
  const i = transfer.targets.findIndex((r) => allHold(r.when, facts));
  return i < 0 ? null : i;
}

/** What a call data key sends: as its `redact` records it, floored by its source's name; null for none (a `secret` key). */
export function sentCallData(def: CallDataKey | undefined, v: string): string | null {
  const shown = recordedCallData(redactionOf(def), v);
  if (shown === null) return null;
  const source = def === undefined ? null : callDataSourceOf(def.from);
  return source === null ? shown : floorByName(source.name, shown);
}

/** What the call has that `send` may read. */
export interface TransferFacts {
  readonly reason: string;
  readonly form: FormId | null;
  readonly callData: Readonly<Record<string, string>>;
  /** The slots as the handoff data sends them (handoff/data.ts handoffDataSlots). */
  readonly slots: Readonly<Record<SlotId, string>>;
}

/** A map of `send` resolved: each reference read from the call, each constant as written; one with nothing to send left out. */
export function resolveSend(app: Pick<App, 'callData'>, values: Readonly<Record<string, string>> | undefined, facts: TransferFacts): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(values ?? {})) {
    const v = transferValueOf(raw);
    let sent: string | null = null;
    if (v.kind === 'reason') sent = facts.reason;
    else if (v.kind === 'form') sent = facts.form;
    else if (v.kind === 'constant') sent = v.value;
    else if (v.kind === 'slot') sent = Object.hasOwn(facts.slots, v.slot) ? facts.slots[v.slot]! : null;
    else {
      const def = app.callData !== undefined && Object.hasOwn(app.callData, v.key) ? app.callData[v.key] : undefined;
      const value = Object.hasOwn(facts.callData, v.key) ? facts.callData[v.key] : undefined;
      sent = def === undefined || value === undefined ? null : sentCallData(def, value);
    }
    if (sent !== null && sent !== '') out[name] = sent;
  }
  return out;
}

/**
 * The transfer an app's handoff makes: the rule taken on the reason, the form and the call data, its
 * variable, and its headers and chat data resolved. Undefined for an app without `transfer`.
 */
export function chooseTransfer(app: Pick<App, 'transfer' | 'callData'>, facts: TransferFacts): TransferChoice | undefined {
  const transfer = app.transfer;
  if (transfer === undefined) return undefined;
  const rule = ruleTaken(transfer, { reason: facts.reason, form: facts.form, callData: facts.callData });
  const to = rule === null ? transfer.default : transfer.targets[rule]!.to;
  const send = sendOf(transfer, rule);
  const headers = resolveSend(app, send.headers, facts);
  const data = resolveSend(app, send.chat, facts);
  return {
    target: envVariableOf(to) ?? to,
    rule,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(Object.keys(data).length > 0 ? { data } : {}),
  };
}

/** The variables an app's transfer names, the targets' in order and then the default's, each once. */
export function transferVariables(transfer: TransferConfig | undefined): string[] {
  if (transfer === undefined) return [];
  const out: string[] = [];
  for (const ref of [...transfer.targets.map((r) => r.to), transfer.default]) {
    const v = envVariableOf(ref);
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The header names an app's transfer may send, in lower case: every rule's and the top-level's. */
export function transferHeaderNames(transfer: TransferConfig | undefined): Set<string> {
  const out = new Set<string>();
  if (transfer === undefined) return out;
  for (const send of [transfer.send, ...transfer.targets.map((r) => r.send)]) for (const name of Object.keys(send?.headers ?? {})) out.add(name.toLowerCase());
  return out;
}

/**
 * Every source a header name or a chat key may be sent from, across the rules and the top-level send:
 * what a record (the trace, the frame log) masks a sent value by (trace/redact.ts).
 */
export function transferSources(transfer: TransferConfig | undefined, part: 'headers' | 'chat'): Map<string, TransferValue[]> {
  const out = new Map<string, TransferValue[]>();
  if (transfer === undefined) return out;
  for (const send of [transfer.send, ...transfer.targets.map((r) => r.send)]) {
    for (const [name, raw] of Object.entries(send?.[part] ?? {})) {
      const key = part === 'headers' ? name.toLowerCase() : name;
      out.set(key, [...(out.get(key) ?? []), transferValueOf(raw)]);
    }
  }
  return out;
}

/** One thing wrong with an app's transfer, at its path under `transfer` (engine terms: a rule's `when` is a list). */
export interface TransferProblem {
  readonly path: readonly (string | number)[];
  readonly message: string;
  readonly fix: string;
  /** A warning (`pnpm check` says it and goes on), not a refusal. */
  readonly warning?: true;
  /** A slot named that is not one of the app's, so a folder's check can give its own fix. */
  readonly unknownSlot?: string;
}

/** What the app has that a transfer names: what its conditions may name (ConditionWorld), and its call data keys. */
export interface TransferWorld extends Omit<ConditionWorld, 'at' | 'callData'> {
  readonly callData?: Readonly<Record<string, CallDataKey>>;
}

/** A misspelling of a reference that would be sent as a constant. */
const LOOKS_LIKE_REFERENCE = /^(?:reason|form|calldata\.|callData\.|slot\.|slots\.|data\.)/i;

/**
 * Everything wrong with an app's transfer (`pnpm check` for a folder, with the warnings; validateApp,
 * the refusals, for an app built in code): a target that is not `env.<NAME>`, a condition or a value
 * that names a form, a call data key or a slot the app does not have, a `secret` key sent, a header
 * name that is not an `X-` name or `User-to-User`, a chat key that is not a plain word, a constant
 * with a control character; and, as warnings, a reason with no handoff line, a rule after one that
 * always holds, a constant that looks like a misspelled reference, and a header the carrier reserves.
 */
export function transferProblems(transfer: TransferConfig | undefined, world: TransferWorld): TransferProblem[] {
  if (transfer === undefined) return [];
  const out: TransferProblem[] = [];
  const add = (path: readonly (string | number)[], message: string, fix: string, extra: Partial<TransferProblem> = {}): void => {
    out.push({ path, message, fix, ...extra });
  };
  const keys = world.callData ?? {};
  const envRef = (path: readonly (string | number)[], ref: unknown): void => {
    if (envVariableOf(ref) === null) add(path, `${JSON.stringify(ref)} is not an environment variable`, 'write env.<NAME> (capitals, digits and underscores) and set the variable to an E.164 number or a sip: URI in the server\'s environment (.env); a number is never written in YAML');
  };
  const sendProblems = (send: TransferSend | undefined, at: readonly (string | number)[]): void => {
    for (const part of ['headers', 'chat'] as const) {
      const seen = new Map<string, string>();
      for (const [name, raw] of Object.entries(send?.[part] ?? {})) {
        const path = [...at, 'send', part, name];
        // SIP header names are not case-sensitive: two that differ only in case would be one header sent twice.
        const twin = part === 'headers' ? seen.get(name.toLowerCase()) : undefined;
        if (twin !== undefined) add(path, `"${name}" is the header "${twin}" again: header names are not case-sensitive`, `keep one of "${twin}" and "${name}"`);
        if (part === 'headers') seen.set(name.toLowerCase(), name);
        if (part === 'headers' && !HEADER_NAME.test(name)) add(path, `"${name}" is not a header a transfer may send`, 'name an X- header (X-Account-Ref) or User-to-User: the headers every carrier documents for a transfer to a SIP address');
        if (part === 'headers' && RESERVED_HEADER.test(name)) add(path, `"${name}" is a header Telnyx reserves for itself (X-Telnyx...)`, 'choose another X- name', { warning: true });
        if (part === 'chat' && !CHAT_DATA_KEY.test(name)) add(path, `"${name}" is not a plain word`, 'name the key with letters, digits and underscores, starting with a letter');
        if (typeof raw !== 'string' || raw === '') {
          add(path, 'names nothing to send', 'write reason, form, callData.<key>, slot.<id>, or a constant');
          continue;
        }
        const v = transferValueOf(raw);
        if (v.kind === 'callData') {
          if (!Object.hasOwn(keys, v.key)) add(path, `callData key "${v.key}" is not defined`, `add "${v.key}" under callData in app.yaml, or name one of ${Object.keys(keys).join(', ') || 'its keys'}`);
          else if (redactionOf(keys[v.key]) === 'secret') add(path, `callData key "${v.key}" is secret, so it is never sent`, 'take it out of send, or give the key another redact (it is sent as that records it)');
          else if (redactionOf(keys[v.key]) === 'mask' || redactionOf(keys[v.key]) === 'length') {
            const how = redactionOf(keys[v.key]);
            add(path, `callData key "${v.key}" is recorded by ${how === 'mask' ? 'mask (the default)' : 'length'}, so this can only ever send ${how === 'mask' ? '•' : 'its length (<9 chars>)'}`, `give the key redact: keep (or last4) if the person taking the call needs the value, or take it out of send`, { warning: true });
          }
        } else if (v.kind === 'slot') {
          if (!world.slots.includes(v.slot)) add(path, `slot "${v.slot}" is not defined`, 'name one of the app\'s slots', { unknownSlot: v.slot });
        } else if (v.kind === 'constant') {
          if (!writableValue(raw)) add(path, 'has a control character (a tab, a newline, or another a transfer cannot carry)', 'write it on one line, with none');
          else if (raw.length > TRANSFER_CONSTANT_MAX) add(path, `is ${raw.length} characters long, and a value sent is at most ${TRANSFER_CONSTANT_MAX}`, 'shorten it');
          else if (LOOKS_LIKE_REFERENCE.test(raw)) add(path, `"${raw}" is sent as written, as a constant, though it looks like a reference`, 'write reason, form, callData.<key> or slot.<id> exactly, or keep it if the words are meant', { warning: true });
        }
      }
    }
  };
  const conditionsOf = (when: readonly Condition[], at: readonly (string | number)[]): void => {
    when.forEach((c, j) => {
      const path = [...at, 'when', j];
      const shape = conditionProblems(c);
      if (shape.length > 0) {
        for (const problem of shape) add(path, `${problem}`, `write a Condition (core/conditions.ts): ${CONDITION_SHAPES}`);
        return;
      }
      for (const p of conditionRefProblems(c, { ...world, at: 'handoff' })) {
        add([...path, p.key], p.message, p.fix, { ...(p.warning ? { warning: true as const } : {}), ...(p.unknownSlot !== undefined ? { unknownSlot: p.unknownSlot } : {}) });
      }
    });
  };
  if (!Array.isArray(transfer.targets)) add(['targets'], 'is not a list of rules', 'write targets: [{ when, to }, ...]');
  let always: number | null = null;
  (Array.isArray(transfer.targets) ? transfer.targets : []).forEach((rule, i) => {
    envRef(['targets', i, 'to'], rule.to);
    if (rule.when !== undefined && !Array.isArray(rule.when)) add(['targets', i, 'when'], 'is not a list of conditions', 'write when: [Condition, ...] (core/conditions.ts)');
    else conditionsOf(rule.when ?? [], ['targets', i]);
    sendProblems(rule.send, ['targets', i]);
    if (always !== null) add(['targets', i], `is never taken: rule ${always + 1} before it always holds`, 'move it above that rule, or give that rule a when', { warning: true });
    else if (Array.isArray(rule.when ?? []) && alwaysHolds(rule.when ?? [])) always = i;
  });
  envRef(['default'], transfer.default);
  sendProblems(transfer.send, []);
  return out;
}
