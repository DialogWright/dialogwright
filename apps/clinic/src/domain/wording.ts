import type { HandoffWording, ModelWording } from 'dialogwright';

/**
 * The engine's own model questions in the clinic's words (App.wording). Each string is sent to the
 * model as it is, so a change re-keys a recorded cassette.
 */
export const CLINIC_WORDING: ModelWording = {
  addressee: 'the clinic phone line',
  tentative: {
    true: 'The hedge is about what the caller wants done, as in maybe cancel it or I guess I need to cancel',
    false: 'The request is stated plainly, even if the caller hedges about a detail such as a date, a provider name, or a number',
  },
  confirmsNo: {
    true: 'The caller says no, says something is wrong, or gives a value that replaces or contradicts a detail the system just read back, including a bare correction such as "not Chen, Cheng" or "Thursday, not Tuesday", whether or not the system itself named the value they reject',
    false: 'The caller agrees, answers something else, or says nothing about the question',
  },
  changeSlot: {
    instructions: 'Read asr.text and node.promptJustPlayed. The caller was read a summary of their appointment and asked to confirm it, or asked what to change. Which detail do they name as wrong or ask to change?',
    order: ['name', 'dob', 'provider', 'date', 'memberId'],
    text: {
      name: 'They name their own name as the thing to change, without saying a new name, as in the name, or you got my name wrong',
      dob: 'They name their date of birth or birthday as the thing to change, without saying the new date, as in the birthday, or my date of birth is wrong',
      provider: 'They name the doctor or provider as the thing to change, without saying who instead, as in the doctor, or not that doctor',
      date: 'They name the day or date as the thing to change, without saying which day instead, as in the day, or the date is wrong (not a different time on the same day)',
      memberId: 'They name the member ID or member number as the thing to change, without saying the digits',
    },
    none: 'They say a new value rather than naming which detail is wrong, such as a weekday, a doctor name, or a string of digits; or they only answer yes or no; or they name nothing',
  },
};

/** The handoff note's words: who takes the call, and the clinic's own handoff reason. */
export const CLINIC_HANDOFF: HandoffWording = {
  recipient: 'clinic front-desk',
  reasons: { billing: 'the caller asked for billing' },
};
