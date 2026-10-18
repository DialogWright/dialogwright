import { identityOf } from './app/lookup';
import { appOf } from './app/registry';
import type { App, IdentityWay, SlotId } from './app/types';
import type { Session } from './session';

/**
 * More than one way to prove level 1 (identity.yaml's `ways`; docs/designs/2026-10-18-identity-ways.md):
 * which way a step-up asks, and which it checks. An app with one set of factors has one way, its own.
 */

/** The ways to prove level 1: identity.yaml's `ways`, or the one way its factors and tool make. */
export function waysOf(app: App): readonly IdentityWay[] {
  const identity = identityOf(app);
  return identity.ways ?? [{ factorSlots: identity.factorSlots, verifyTool: identity.verifyTool }];
}

const given = (s: Session, way: IdentityWay): number => way.factorSlots.filter((id) => (s.slots[id]?.value ?? null) !== null).length;

/**
 * The way a step-up is on: the one it was on (Session.identityWay, the first at the start), unless the
 * caller has given more of another way's factors ("my number is ..." at the code's question), which it
 * then takes.
 */
export function wayInUse(s: Session): number {
  const ways = waysOf(appOf(s));
  if (ways.length === 1) return 0;
  let best = Math.min(s.identityWay ?? 0, ways.length - 1);
  ways.forEach((w, i) => {
    if (given(s, w) > given(s, ways[best]!)) best = i;
  });
  return best;
}

/** The way after the one `slot` is a factor of, to move a caller to who missed its question; null when there is none (one way, the last way, or no factor). */
export function nextWayAfter(app: App, slot: SlotId): number | null {
  const ways = waysOf(app);
  if (ways.length === 1) return null;
  const at = ways.findIndex((w) => w.factorSlots.includes(slot));
  return at === -1 || at === ways.length - 1 ? null : at + 1;
}
