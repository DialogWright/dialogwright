import type { OutboundFrame } from '../channel/relay/frames';
import { actionsToFrames } from '../channel/relay/map';
import type { TurnResult } from '../core/turn';

/** A turn's actions as the voice adapter puts them on the wire, for tests that pin frames. */
export function framesOf(result: Pick<TurnResult, 'actions'>): OutboundFrame[] {
  return actionsToFrames(result.actions);
}
