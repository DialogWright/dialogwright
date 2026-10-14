import type { App } from './app/types';
import type { Session } from './session';
import type { AuditDraft } from '../audit/types';
import { callDataSourceOf, recordedCallDataMap, usableCallDataValue } from '../channel/callData';
import { floorByName, recordsOf } from '../channel/maskByName';

/**
 * The data a call or chat came with that the app names (app.yaml's `callData`, App.callData): the
 * channel reads each key from its source (channel/callData.ts callDataFrom), the start event carries
 * them (SessionStart.callData), and the session keeps them (Session.callData) for the app's code,
 * read with callDataOf. The model never sees them unless the app's callerState passes one.
 */

const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

/**
 * What the session keeps of the call data a start event carried: the keys the app names, each a
 * value the channel could have read (channel/callData.ts usableCallDataValue: not empty, no longer
 * than the wire takes, nothing a start document cannot carry), whoever made the event (a seed, a test). Undefined when none is left, and for an
 * app without `callData`, so every other session is as it was.
 */
export function keptCallData(app: App, raw: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  const spec = app.callData;
  if (spec === undefined || raw === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(spec)) {
    const v = Object.hasOwn(raw, key) ? raw[key] : undefined;
    if (usableCallDataValue(v)) out[key] = v;
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
 * one left out, never less masked than its source's name asks (channel/maskByName.ts), as `callData.<key>`. Nothing for an app without `callData` or a call that came with
 * none, so every other row is as it was.
 */
export function callDataAuditDetail(app: App, s: Session): AuditDraft['detail'] {
  const spec = app.callData;
  if (spec === undefined || s.callData === undefined) return {};
  const shown = recordedCallDataMap(spec, s.callData);
  // The audit holds no caller's number or name whole, whatever a key's redact, unless app.yaml's records
  // keep them: the masking by the name its source has is a floor, as in the frame log.
  return Object.fromEntries(Object.entries(shown).flatMap(([k, v]) => {
    const source = Object.hasOwn(spec, k) ? callDataSourceOf(spec[k]!.from) : null;
    const floored = source === null ? v : floorByName(source.name, v, recordsOf(app));
    return floored === null ? [] : [[`callData.${k}`, floored]];
  }));
}
