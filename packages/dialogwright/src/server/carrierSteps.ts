/**
 * Where to paste the webhook in each carrier's console, as `pnpm configure` and `pnpm start` print
 * it. The labels are the ones the carriers' own pages use as of this writing; portals move them, and
 * what matters is the field: the number's (or application's) voice webhook, method POST.
 */
export function carrierSteps(carrier: string, webhook: string): string[] {
  if (carrier === 'telnyx') {
    return [
      'In the Telnyx Mission Control Portal:',
      '  1. Get a number with voice (Numbers, Buy Numbers).',
      '  2. Real-Time Communications, Voice, Programmable Voice, TeXML Applications: create an application.',
      `  3. Send a TeXML Webhook to the URL: ${webhook}, Voice Method POST.`,
      '  4. Assign your number to the application (its Numbers tab).',
      '  Worth it: a Webhook Failover URL (a TeXML Bin that dials your mobile) is asked when this server does not answer.',
    ];
  }
  if (carrier === 'twilio') {
    return [
      'In the Twilio Console:',
      '  1. Phone Numbers, Manage, Active numbers: choose your number.',
      `  2. Voice Configuration, A call comes in: Webhook, ${webhook}, HTTP POST.`,
      '  Worth it: Primary handler fails takes a fallback URL (a TwiML Bin that dials your mobile), asked when this server does not answer.',
    ];
  }
  return [`Point the carrier's voice webhook at ${webhook} (POST).`];
}
