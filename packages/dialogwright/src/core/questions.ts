import { PRICE_LINE, PRICE_QUESTION, type AgentAppField } from '../agent/types';
import type { QuestionMap } from '../jev/types';
import type { SlotContext, SlotSpec } from './slots/types';
import { formIntents, intentCriteria } from './app/intents';
import { formSlotsFor, slotSpecOf } from './app/lookup';
import type { Principal } from '../gate/types';
import { appOf } from './app/registry';
import type { App, FormId, SlotId } from './app/types';
import { activeSlots, questionCtx } from './fia';
import { callerMatchAsks } from './identityWays';
import { ENGINE_QUESTION_IDS } from './questionIds';
import type { Session } from './session';

export { ALWAYS_ON_IDS, ENGINE_QUESTION_IDS } from './questionIds';

/**
 * The engine's own words for what an app's ModelWording leaves out: neutral, naming no domain.
 * An app supplies its own (App.wording) so the model reads the app's terms.
 */
export const NEUTRAL_WORDING = {
  addressee: 'this service',
  tentative: {
    true: 'The hedge is about what the caller wants done, as in maybe I should ask about that or I guess I need help with something',
    false: 'The request is stated plainly, even if the caller hedges about a detail such as a date, a name, or a number',
  },
  confirmsNo: {
    true: 'The caller says no, says something is wrong, or gives a value that replaces or contradicts a detail the system just read back, including a bare correction such as "not the twelfth, the thirteenth" or "Saturday, not Friday", whether or not the system itself named the value they reject',
    false: 'The caller agrees, answers something else, or says nothing about the question',
  },
  changeSlot: {
    instructions: 'Read asr.text and node.promptJustPlayed. The caller was read a summary of their request and asked to confirm it, or asked what to change. Which detail do they name as wrong or ask to change?',
    none: 'They say a new value rather than naming which detail is wrong, such as a date, a name, or a string of digits; or they only answer yes or no; or they name nothing',
  },
} as const;

function alwaysOn(app: App): QuestionMap {
  const w = app.wording;
  const tentative = w?.tentative ?? NEUTRAL_WORDING.tentative;
  return {
    intent: {
      type: 'choice',
      instructions: `Read asr.text. What is the caller asking ${w?.addressee ?? NEUTRAL_WORDING.addressee} to do? If they are only answering a slot or confirmation question and not asking for anything new, choose none. When they ask for two separate things, choose the one they ask for first.`,
      criteria: intentCriteria(app),
    },
    intentTentative: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller express their request tentatively, with words such as maybe, I guess, I think, possibly, or might, rather than stating it plainly?',
      criteria: {
        true: tentative.true,
        false: tentative.false,
      },
    },
    addressedToSystem: {
      type: 'noul',
      instructions: 'Read asr.text. Is the caller speaking to the phone system, as opposed to someone else in the room, a television, or themselves?',
      criteria: {
        true: 'Anything said in reply to the phone system, including a short answer or correction to the question it just asked, such as a name, a day, a number, a yes or no, or a bare correction',
        false: 'Talking to someone else in the room, to a television, or to themselves, even when what they say is about the call',
      },
    },
    utteranceComplete: {
      type: 'noul',
      instructions: 'Read asr.text. Has the caller finished their thought, rather than trailing off or being cut short?',
    },
    // Asking whether one is talking to a person is not asking for one (the maintainer's decision,
    // 2026-10-16, Harbor findings item 6): the model is told what the caller is talking to, and what
    // the question is for, not a procedure for the words.
    wantsHuman: {
      type: 'noul',
      instructions: `Read asr.text. The caller is talking to ${w?.addressee ?? NEUTRAL_WORDING.addressee}, which is automated. Does the caller ask to talk to a person instead, such as an agent, a representative, or an operator?`,
      criteria: {
        true: 'The caller asks to talk to a person or to be put through to one, even in a single word such as agent or representative',
        false: 'The caller asks for something else, or for nothing. Asking whether they are talking to a person, a robot or a machine asks what this service is, not to talk to someone else',
      },
    },
    rephrasingLastTurn: {
      type: 'noul',
      instructions: "Read asr.text and history. Is the caller repeating or rewording a request because the previous turn's outcome in history shows the system did not act on it?",
    },
    confusedByPrompt: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. Does the caller sound confused by what the system just asked?',
    },
    spokeAMenuNumber: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller say a single number as if choosing a menu option, such as "one" or "press two"?',
    },
    frustration: {
      type: 'score',
      instructions: 'Read asr.text. How frustrated does the caller sound?',
      levels: [
        { label: 'none', description: 'Calm or neutral wording, including a plain request made once' },
        { label: 'mild', description: 'A sigh, an ugh, a come on or a seriously attached to an otherwise plain request, or a complaint about waiting, with no sign the caller is repeating themselves' },
        { label: 'high', description: 'The caller says they already said or told us something, counts the attempts as in for the third time, asks are you kidding me, calls it ridiculous, swears, insults the system, or threatens to hang up or complain' },
      ],
    },
    urgency: {
      type: 'score',
      instructions: 'Read asr.text. How urgent is the caller\'s need?',
      levels: [
        { label: 'low', description: 'No time pressure mentioned' },
        { label: 'normal', description: 'Wants it handled soon' },
        { label: 'high', description: 'Says it is urgent, an emergency, or must happen today' },
      ],
    },
    triedSelfService: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller say they already tried the website, the app, or an earlier call?',
    },
    languageSwitch: {
      type: 'choice',
      instructions: 'Read asr.text. Which language other than English does the caller ask for or speak, if any?',
      criteria: { none: 'English', es: 'Spanish', fr: 'French' },
    },
    intelligible: {
      type: 'noul',
      instructions: 'Read asr.text. Is the text words the caller actually said, rather than garbled fragments or background noise?',
      criteria: {
        true: 'Any real utterance, including a single word, a yes or no, a name, a number, or a string of digits',
        false: 'Garbled fragments, transcribed noise, or nothing but a filler sound such as um or uh',
      },
    },
  };
}

function confirmation(app: App): QuestionMap {
  const no = app.wording?.confirmsNo ?? NEUTRAL_WORDING.confirmsNo;
  return {
    confirmsYes: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. Does the caller answer yes to the confirmation question?',
    },
    confirmsNo: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. Does the caller answer no to the confirmation question?',
      criteria: {
        true: no.true,
        false: no.false,
      },
    },
  };
}

/**
 * What an in-form utterance does to the current task. Asked only inside a form.
 * answering is first because quietAnswer() defaults a none-less Choice to labels[0], matching the
 * below-threshold default.
 */
function inForm(): QuestionMap {
  return {
    intentChange: {
      type: 'choice',
      instructions: 'Read asr.text. The caller is in the middle of the task described by activeFormLabel and was just asked node.promptJustPlayed. Which best describes this utterance?',
      criteria: {
        answering: 'Answers or reacts to the question that was just asked, restates the current task, or says something incidental; anything that is not a request for a different task',
        adding: 'Asks for an additional task to be handled as well, while keeping the current one, for example with also, as well, and another thing, or after this',
        replacing: 'Abandons the current task in favour of a different one, for example with never mind, forget that, instead, or actually I just want',
      },
    },
  };
}

/**
 * A second task named on the opening utterance. Deliberately asked on
 * every out-of-form turn -- menu and intent-confirm turns included -- because the gate only
 * acts on this answer for a plain route; asking it everywhere else keeps the question set stable.
 */
function noForm(app: App): QuestionMap {
  const criteria: Record<string, string> = {};
  for (const i of formIntents(app)) criteria[i] = `A second, separate request on top of the main one: ${app.intents[i]!.criteria}`;
  criteria.none = 'Everything the caller says belongs to one request, even if they describe it twice or add details to it; or they ask for nothing';
  return {
    secondIntent: {
      type: 'choice',
      instructions: 'Read asr.text. The caller states one main request. Does the same utterance also ask for a second, separate task on top of it, joined by words such as and also, as well, another thing, or while I have you? If so, which is the extra task? Choose none when everything they say is part of one request.',
      criteria,
    },
  };
}

/**
 * The slots changeSlot can offer, each with its criterion, in a fixed presentation order (the app's
 * ModelWording.changeSlot.order). The question has a `none`, so a quiet answer lands there whatever
 * the order -- unlike intentChange, which has no none and so falls to its first label. The order is
 * pinned only so the wire order, and any option-order bias in the model's answer, stay stable
 * across runs. Without the app's own, the form's slots in its order, each named by its id.
 */
function changeSlotCriteria(app: App, form: FormId, principal: Principal): Record<string, string> {
  // Only the slots asked of this caller (SlotSpec.askedOf): a slot they were never asked is no detail to change.
  const slots = formSlotsFor(app, form, principal);
  const own = app.wording?.changeSlot;
  const criteria: Record<string, string> = {};
  if (own?.order) {
    for (const id of own.order) if (slots.includes(id)) criteria[id] = own.text?.[id] ?? neutralChangeText(id);
  } else {
    for (const id of slots) criteria[id] = neutralChangeText(id);
  }
  return criteria;
}

function neutralChangeText(id: SlotId): string {
  return `They name the ${id} as the thing to change, without saying its new value`;
}

/**
 * Which detail the caller names when asked what to change. Criteria are
 * disjoint from value-giving answers (naming a detail, not giving its new value) and limited to
 * the slots on the current form. Asked only while the summary is pending.
 */
function formConfirmation(app: App, form: FormId, principal: Principal): QuestionMap {
  const own = app.wording?.changeSlot;
  const criteria = changeSlotCriteria(app, form, principal);
  criteria.none = own?.none ?? NEUTRAL_WORDING.changeSlot.none;
  return {
    changeSlot: {
      type: 'choice',
      instructions: own?.instructions ?? NEUTRAL_WORDING.changeSlot.instructions,
      criteria,
    },
  };
}

function menu(app: App): QuestionMap {
  const criteria: Record<string, string | null> = {};
  for (const { digit } of app.menu) criteria[digit] = null;
  criteria.none = 'No menu number said';
  return {
    menuNumberSaid: {
      type: 'choice',
      instructions: 'Read asr.text. Which menu number from node.options does the caller say, if any?',
      criteria,
    },
  };
}

/**
 * Whether the caller turned down the caller-ID match (identity.yaml's `callerId`): a no, "different
 * account" or "that's not me" at the caller-ID question, or at a factor asked while the match stands.
 * Asked only then (callerMatchAsked), so it changes no request of any other app, nor of this one
 * anywhere else.
 */
function callerMatch(): QuestionMap {
  return {
    callerMatchDeclined: {
      type: 'noul',
      instructions: 'Read asr.text and node.promptJustPlayed. The system found an account for the number the caller is calling from and asked for a detail to access it, or to say different account. Does the caller turn that account down?',
      criteria: {
        true: 'The caller says no, different account, another account, that is not me, that is not my account, or that they want to give another account number',
        false: 'The caller gives the detail asked for, such as a date, agrees, asks for something else, or says nothing about which account',
      },
    },
  };
}

/**
 * The caller is answering the caller-ID question, or a factor asked while the match stands: the match
 * is in use (Session.callerMatch `offered`), the caller is not yet verified, and the prompt asked for a
 * factor the match does not identify.
 */
export function callerMatchAsked(session: Session): boolean {
  const identity = appOf(session).identity;
  const asked = session.promptedFor;
  if (session.callerMatch !== 'offered' || identity?.callerId === undefined || session.principal.level !== 0 || asked === null) return false;
  return callerMatchAsks(appOf(session)).includes(asked);
}

/**
 * The factors a caller-ID match in use identifies, asked about at the caller-ID question though they
 * do not listen (fia.ts activeSlots): "different account, it's 5550 5678" keeps the number, since the
 * turn fills them only when it turns the match down (core/turn.ts). None on every other turn.
 */
function heldByCallerMatch(session: Session): SlotSpec[] {
  const app = appOf(session);
  if (!callerMatchAsked(session)) return [];
  return (app.identity?.callerId?.identifies ?? []).map((id) => slotSpecOf(app, id));
}

/**
 * What the decision model is asked on a turn of an app in agent mode (core/agentTurn.ts): only what it
 * reads on every turn (side speech, words made out, a person asked for, frustration, the language, the
 * request), and at a pending confirmation the yes or the no, since that decides what is done; where the
 * app has a price line, whether the caller asks what something costs, since that decides whether it is
 * said. No field's question: the agent model understands the values, and each field's slot type checks them.
 */
function agentModeQuestions(app: App, session: Session): QuestionMap {
  return {
    ...alwaysOn(app),
    ...(app.agent?.lines[PRICE_LINE] !== undefined ? priceAsked() : {}),
    ...(session.pendingConfirmation || yesNoFieldAsked(app, session) !== null ? confirmation(app) : {}),
  };
}

/**
 * In agent mode, the field of the form open whose question the line has just asked (Session.promptedFor),
 * where it is a choice whose options are exactly yes and no (a consent: "Is it OK if we text you at that
 * number?"): the decision model is asked its yes or no that turn, as at a read-back, and a clear reading
 * fills the field (core/agentTurn.ts yesNoRead; the agent-mode design's call 49). Null on every other turn.
 */
export function yesNoFieldAsked(app: App, session: Session): AgentAppField | null {
  if (session.form === null || session.pendingConfirmation !== null || session.promptedFor === null) return null;
  const field = app.agent?.forms[session.form]?.fields.find((f) => f.slot === session.promptedFor);
  if (field === undefined || field.type !== 'choice') return null;
  const options = (field.options ?? []).map((o) => o.trim().toLowerCase()).sort();
  return options.length === 2 && options[0] === 'no' && options[1] === 'yes' ? field : null;
}

/**
 * Whether the caller asks what something costs: asked on every turn of an app in agent mode that has a price
 * line (business.yaml's `prices`), and nowhere else. The price line is said where this reads at
 * AGENT_PRICE_ASKED or above, whether or not the agent model named it, and never where it reads under it
 * (core/agentTurn.ts; the agent-mode design, call 43): a live chat's agent model named it on the turn the
 * caller gave a callback number, as a "what happens next", and the whole line was said with no price asked.
 */
function priceAsked(): QuestionMap {
  return {
    [PRICE_QUESTION]: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller ask what something costs, such as a price, a fee, a quote, or how much it is?',
      criteria: {
        true: 'The caller asks what something costs or will cost: a price, a fee, a rate, an estimate or a quote, or how much it is, even roughly, as a range, or by proposing a figure',
        false: 'The caller asks about something else, gives a detail such as a name, a day, a count or a phone number, answers the question just asked, or says nothing about what anything costs',
      },
    },
  };
}

export function buildQuestions(session: Session, ctx: SlotContext): QuestionMap {
  const app = appOf(session);
  // A call of an app in agent mode that began with no agent client runs as a scripted app (Session.agent.scripted).
  if (app.mode === 'agent' && session.agent?.scripted !== true) return agentModeQuestions(app, session);
  const q: QuestionMap = { ...alwaysOn(app) };
  // Which slot asks each slot question this turn: a slot's question that took another's id, or one
  // of the engine's, would replace it unseen, so it throws instead. A slot that declares its ids
  // (SlotSpec.questionIds; validateApp checked them against each other and the engine's) may ask
  // only those.
  const askedBy = new Map<string, SlotId>();
  for (const spec of [...activeSlots(session), ...heldByCallerMatch(session)]) {
    const own = spec.questions(questionCtx(session, ctx, spec.id));
    for (const id of Object.keys(own)) {
      if (ENGINE_QUESTION_IDS.includes(id)) throw new Error(`app "${app.id}": slot "${spec.id}" asks the question "${id}", which is one the engine asks`);
      const other = askedBy.get(id);
      if (other !== undefined) throw new Error(`app "${app.id}": slots "${other}" and "${spec.id}" both ask the question "${id}"`);
      if (spec.questionIds !== undefined && !spec.questionIds.includes(id)) throw new Error(`app "${app.id}": slot "${spec.id}" asks the question "${id}", which is not in its questionIds`);
      askedBy.set(id, spec.id);
    }
    Object.assign(q, own);
  }
  if (session.form) Object.assign(q, inForm());
  if (!session.form) Object.assign(q, noForm(app));
  if (session.pendingConfirmation) Object.assign(q, confirmation(app));
  if (session.pendingConfirmation?.target === 'form') Object.assign(q, formConfirmation(app, session.pendingConfirmation.form, session.principal));
  if (session.menuActive) Object.assign(q, menu(app));
  if (callerMatchAsked(session)) Object.assign(q, callerMatch());
  // The app's own, last, and only where it has any: an app without them asks exactly the above.
  const own = app.questions?.(session, ctx);
  if (own) {
    const declared = declaredIdsOf(app);
    for (const id of Object.keys(own)) {
      if (ENGINE_QUESTION_IDS.includes(id) || Object.hasOwn(q, id)) throw new Error(`app "${app.id}": its question "${id}" is one the engine or a slot asks`);
      // A slot that declares its ids owns them on every turn, even one it is not asked on.
      if (declared.has(id)) throw new Error(`app "${app.id}": its question "${id}" is one the slot "${declared.get(id)}" declares (questionIds)`);
    }
    Object.assign(q, own);
  }
  return q;
}

/** The question ids the app's slots declare (SlotSpec.questionIds), each with the slot that declares it. */
function declaredIdsOf(app: App): Map<string, SlotId> {
  const ids = new Map<string, SlotId>();
  for (const spec of Object.values(app.slots)) for (const id of spec.questionIds ?? []) if (!ids.has(id)) ids.set(id, spec.id);
  return ids;
}
