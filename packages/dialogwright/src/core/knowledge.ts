import type { SessionEvent } from '../channel/events';
import type { Nomination } from '../kb/types';
import { appOf } from './app/registry';
import { activeSlots } from './fia';
import type { Session } from './session';
import type { SlotSpec } from './slots/types';

/**
 * What the turn knows of the knowledge base before it is planned (TurnContext.knowledge): the topics
 * the app's retriever nominated for its words, best first. Set only on a turn the retrieval step ran
 * for (topicsListening); empty when the retriever nominated nothing, failed, was late, or the app
 * gives none.
 */
export interface TurnKnowledge {
  readonly nominated: readonly Nomination[];
}

/** Whether a slot reads the topics retrieval nominates (SlotSpec.nominates): a topic slot. */
export function isTopicSlot(spec: SlotSpec): boolean {
  return spec.nominates === true;
}

/**
 * Whether this turn retrieves: the app has a knowledge base, the event carries words the model will
 * be asked about (plan() asks it, so not after the call ended or while a downstream service's answer
 * is awaited), and a topic slot is among the slots the turn asks (activeSlots). An app without a
 * knowledge base never retrieves, so its turns are exactly as they were.
 */
export function topicsListening(session: Session, event: SessionEvent, duringService: boolean | undefined): boolean {
  if (event.type !== 'user.speech' && event.type !== 'user.text') return false;
  if (session.ended || session.pendingService !== null || duringService === true) return false;
  if (appOf(session).knowledge === undefined) return false;
  return activeSlots(session).some(isTopicSlot);
}
