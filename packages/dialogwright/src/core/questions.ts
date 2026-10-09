import type { QuestionMap } from '../jev/types';
import type { SlotContext, SlotSpec } from './slots/types';
import { formIntents, intentCriteria } from './app/intents';
import { formOf, slotSpecOf } from './app/lookup';
import { appOf } from './app/registry';
import type { App, FormId, SlotId } from './app/types';
import { activeSlots, slotCtx } from './fia';
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
    wantsHuman: {
      type: 'noul',
      instructions: 'Read asr.text. Does the caller explicitly ask to talk to a person, an agent, a representative, or an operator?',
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
function changeSlotCriteria(app: App, form: FormId): Record<string, string> {
  const slots = formOf(app, form).slots;
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
function formConfirmation(app: App, form: FormId): QuestionMap {
  const own = app.wording?.changeSlot;
  const criteria = changeSlotCriteria(app, form);
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
  return identity.factorSlots.includes(asked) && !identity.callerId.identifies.includes(asked);
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

export function buildQuestions(session: Session, ctx: SlotContext): QuestionMap {
  const app = appOf(session);
  const q: QuestionMap = { ...alwaysOn(app) };
  // Which slot asks each slot question this turn: a slot's question that took another's id, or one
  // of the engine's, would replace it unseen, so it throws instead. A slot that declares its ids
  // (SlotSpec.questionIds; validateApp checked them against each other and the engine's) may ask
  // only those.
  const askedBy = new Map<string, SlotId>();
  for (const spec of [...activeSlots(session), ...heldByCallerMatch(session)]) {
    const own = spec.questions(slotCtx(session, ctx, spec.id));
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
  if (session.pendingConfirmation?.target === 'form') Object.assign(q, formConfirmation(app, session.pendingConfirmation.form));
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
