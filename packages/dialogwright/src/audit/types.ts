/** What the pure core emits. No PHI: ids by last four, never a date of birth, code or statement. */
export interface AuditDraft {
  /**
   * The engine's own rows: call_started, screen_fired, screen_error, identity, gate, tool_result,
   * code_spoken (a one-time code said aloud at the code prompt: masked on arrival, and a new code
   * sent), handoff, handoff_summary, call_ended. An app's tools and services add their own
   * (ToolDef.audit, ServiceDef.audit; e.g. report_created, kb_answer, a2a).
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
