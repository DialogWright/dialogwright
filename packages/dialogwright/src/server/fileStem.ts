/**
 * The name a call's trace and frame log are written under: `<safeFileStem(callId)>.jsonl` and
 * `<safeFileStem(callId)>.frames.jsonl`. Every lookup of a trace by a call's id (the console's replay,
 * its live feed of one call) goes through this same mapping, so a carrier's id with a character a file
 * name may not hold (a Telnyx id's `v3:`) still finds its trace. The console's page mirrors it exactly
 * (view.js `traceName`; a test holds the two equal).
 *
 * Call ids arrive over the socket, so never let one shape a path. Dots are replaced too, not only
 * separators: a call id of `CA1.frames` would otherwise write its trace to `CA1.frames.jsonl` and collide
 * with call CA1's frame log.
 */
export function safeFileStem(callSid: string): string {
  const cleaned = callSid.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length ? cleaned.slice(0, 64) : 'unknown';
}
