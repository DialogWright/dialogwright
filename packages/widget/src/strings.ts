/**
 * Every word the widget shows, in English: a site replaces any of them (`strings`, or JSON in
 * `data-strings`) to word the widget its own way or in its own language. The agent's lines are the
 * app's, in the language the chat speaks; these are the widget's own.
 */
export const DEFAULT_STRINGS = {
  /** The launcher button that opens the panel. */
  open: 'Chat',
  /** The close button's label (it shows a cross). */
  close: 'Close chat',
  /** The panel's heading, unless `title` is set. */
  title: 'Chat with us',
  /** The conversation's label, for screen readers. */
  log: 'Conversation',
  /** The message box's label, for screen readers. */
  message: 'Message',
  placeholder: 'Type your message',
  send: 'Send',
  /** Shown before each of the person's own lines, for screen readers. */
  you: 'You:',
  /** Shown before each of the agent's lines, for screen readers. */
  agent: 'Agent:',
  /** The button that asks the site for a sign-in, shown when the site gives a token (getToken). */
  signIn: 'Sign in',
  signedIn: 'You are signed in.',
  signInFailed: 'We could not sign you in.',
  connecting: 'Connecting...',
  reconnecting: 'Reconnecting...',
  /** The chat a resume named had ended, and a new one started. */
  restarted: 'The chat started again.',
  /** The server is full and the widget has stopped trying. */
  unavailable: 'Chat is busy right now. Please try again later.',
  /** Too many messages are waiting for their reply. */
  wait: 'Please wait for the reply.',
  tooLong: 'That message is too long.',
  ended: 'This chat has ended.',
  /** Shown on a transfer when the site has no onTransfer of its own. */
  transferred: 'We are passing you to a person.',
  error: 'Something went wrong. Please try again.',
};

export type WidgetStrings = typeof DEFAULT_STRINGS;
export type StringKey = keyof WidgetStrings;

/** The site's words over the defaults; a key the widget does not have is warned about and left out. */
export function stringsOf(site: Readonly<Record<string, string>> | undefined, warn: (m: string) => void): WidgetStrings {
  const out: WidgetStrings = { ...DEFAULT_STRINGS };
  for (const [k, v] of Object.entries(site ?? {})) {
    if (!(k in DEFAULT_STRINGS)) warn(`DialogWright widget: strings has no word "${k}" (it has ${Object.keys(DEFAULT_STRINGS).join(', ')})`);
    else if (typeof v !== 'string') warn(`DialogWright widget: strings.${k} must be text`);
    else out[k as StringKey] = v;
  }
  return out;
}
