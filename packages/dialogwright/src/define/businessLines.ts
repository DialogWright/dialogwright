/**
 * The engine's own lines in an app in agent mode, by id, where business.yaml's `lines` does not give
 * them in the business's words. An agent-mode app has no prompts.yaml: the engine builds its prompts
 * (./businessFiles.ts) from business.yaml's fixed lines (the read-backs, the done lines, the price
 * line, the handoff, the closing), each field's question, and these. Each is said word for word, as
 * every line of a scripted app is; none is generated. They are neutral, as the engine's vocabulary is,
 * and in English (the prototype's one locale).
 */
export const AGENT_DEFAULT_LINES: Readonly<Record<string, string>> = {
  ask_intent: 'How can I help?',
  nomatch_open: "Sorry, I didn't catch that. How can I help?",
  no_input: "I didn't hear anything.",
  ack_intent: 'Sure, I can help you {intentLabel}.',
  confirm_intent_explicit: 'Just to check, do you want to {intentLabel}?',
  disambiguate_intent: 'Do you want to {a}, or {b}?',
  ack_intent_then: "Sure. Let's {a} first, then {b}.",
  ack_queued: "Sure, I'll help you {intentLabel} after this.",
  bridge_next: "Now, let's {intentLabel}.",
  ack_frustration: "I understand, let's get this sorted.",
  ack_declined: 'No problem.',
  system_slow_dtmf_hint: 'One moment.',
  system_slow_chat: 'One moment.',
  ask_change: 'What should I change?',
  confirm_dtmf: 'Press 1 for yes, or 2 for no.',
  anything_else: 'Is there anything else I can help with?',
  screen_reprompt: "I can't help with that. How can I help?",
  screen_reprompt_form: "I can't help with that. Let's carry on.",
  identity_verified: 'Thanks, {first}.',
  identity_failed: "I couldn't match the number you're calling from to an account.",
  identity_caller_match: "I see the number you're calling from is on file.",
};

/**
 * The engine's lines a person asked for or needed is told (every handoff, the transfer offer): in agent
 * mode there is no live transfer, so each says business.yaml's `handoff` (a callback, in the business's
 * words), unless `lines` gives it.
 */
export const AGENT_HANDOFF_LINES: readonly string[] = [
  'offer_transfer',
  'handoff_live_agent',
  'handoff_frustrated',
  'handoff_max_attempts',
  'handoff_system_failure',
  'handoff_needs_human',
  'handoff_security',
  'handoff_identity',
];

/** The lines a call and a chat end on: business.yaml's `closing`, unless `lines` gives them. */
export const AGENT_CLOSING_LINES: readonly string[] = ['goodbye', 'goodbye_chat'];

/** Every engine line business.yaml's `lines` may give in the business's words. */
export const AGENT_LINE_IDS: readonly string[] = [...Object.keys(AGENT_DEFAULT_LINES), ...AGENT_HANDOFF_LINES, ...AGENT_CLOSING_LINES];

/** The line a digits field that offers the number the caller is calling from (`offer: callerNumber`) offers it with: its offer_<slot>. */
export const AGENT_OFFER_LINE = "Is the number you're calling from, ending in {last4}, the best one to reach you?";

/** The account slot's question: never asked (the account is recognized by the number calling), but the engine has a line for every slot. */
export const AGENT_ACCOUNT_LINE = 'Which account are you calling for?';
