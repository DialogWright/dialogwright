/** What the pure core emits. No PHI: ids by last four, never a date of birth, code or statement. */
export interface AuditDraft {
  /**
   * The engine's own rows: call_started, screen_fired, screen_error, identity, gate, tool_result,
   * code_spoken (a one-time code said aloud at the code prompt: masked on arrival, and a new code
   * sent), form_stopped (a form's check refused and ended the form: the form, the check's action,
   * the reason and how it ended, and `confirmed` when its refusal was read back first and the caller
   * said yes), check_reconfirmed (a check's read-back the caller said no to: the form, the action and
   * the reason, the slots it reads emptied to be asked again), offer (an offer settled, of the number the caller is calling from or
   * of a value proposed from the facts: the slot, the line as said, the answer and how it was given;
   * `answer: consent` for a slot filled from the call's consent to text, with that question's line),
   * consent (the consent to text for the whole call, app.yaml's textConsent: `scope: call`, granted
   * true, false or null, the line as said and how it was answered),
   * identity_caller_match (the caller-ID match of identity.yaml's callerId: its outcome, offered,
   * verified, declined or failed, and the number calling as policy.yaml's audit: records it, never the
   * identifier), handoff, handoff_summary, call_ended. An app's tools and services add their own
   * (ToolDef.audit, ServiceDef.audit; e.g. report_created, a2a), and kb_answer for an answer read
   * from the knowledge base (kb/record.ts kbAuditRow).
   */
  type: string;
  detail: Record<string, string | number | boolean | null | string[]>;
}

export interface AuditEntry extends AuditDraft {
  seq: number;
  at: string;       // ISO timestamp
  callId: string;
  channel: string;
  prevHash: string; // "0" x 64 for the first entry of a file
  hash: string;     // sha256 over canonical JSON of every other field
}
