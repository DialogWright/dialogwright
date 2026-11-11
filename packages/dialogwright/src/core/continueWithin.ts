/**
 * app.yaml's voice.continueWithinMs, its default and its largest value: a leaf module, so app.yaml's
 * schema (define/schema/app.ts), which the converse runtime reads too, needs nothing of the turn runner
 * (run/continuation.ts, which re-exports these).
 */

/** voice.continueWithinMs when the app does not set it. */
export const DEFAULT_CONTINUE_WITHIN_MS = 300;
/** The largest voice.continueWithinMs an app may set: past two seconds, an interrupt can be a reply. */
export const MAX_CONTINUE_WITHIN_MS = 2000;
