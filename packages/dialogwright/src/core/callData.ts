import type { App } from './app/types';
import type { Session } from './session';
import type { AuditDraft } from '../audit/types';
import { CALL_DATA_VALUE_MAX, recordedCallDataMap } from '../channel/callData';

/**
 * The data a call or chat came with that the app names (app.yaml's `callData`, App.callData): the
 * channel reads each key from its source (channel/callData.ts callDataFrom), the start event carries
 * them (SessionStart.callData), and the session keeps them (Session.callData) for the app's code,
 * read with callDataOf. The model never sees them unless the app's callerState passes one.
 */

const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

/**
 * What the session keeps of the call data a start event carried: the keys the app names, each a
 * string with something in it no longer than the wire takes. Undefined when none is left, and for an
 * app without `callData`, so every other session is as it was.
 */
export function keptCallData(app: App, raw: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  const spec = app.callData;
  if (spec === undefined || raw === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(spec)) {
    const v = Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (typeof v === 'string' && v !== '' && v.length <= CALL_DATA_VALUE_MAX) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The call data the session kept, by the app's keys (app.yaml's `callData`): a key whose source sent
 * nothing is absent. An empty object for an app without `callData`, on a call or chat that came with
 * none of it, and on a session started before it was kept, so code written against it is safe anywhere.
 * A reconnect keeps the first setup's values.
 */
export function callDataOf(s: Session): Readonly<Record<string, string>> {
  return s.callData ?? EMPTY;
}

/**
 * The call_started audit row's call data: each key as its `redact` says (default `mask`), a `secret`
 * one left out, as `callData.<key>`. Nothing for an app without `callData` or a call that came with
 * none, so every other row is as it was.
 */
export function callDataAuditDetail(app: App, s: Session): AuditDraft['detail'] {
  if (app.callData === undefined || s.callData === undefined) return {};
  const shown = recordedCallDataMap(app.callData, s.callData);
  return Object.fromEntries(Object.entries(shown).map(([k, v]) => [`callData.${k}`, v]));
}
