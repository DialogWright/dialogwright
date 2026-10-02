import type { Level, PolicyTables } from 'dialogwright';
import type { ClinicTool } from './tools';

/**
 * The clinic's action policy. The clinic verifies no one (no App.identity), so every tool is at
 * level 0: the gate cannot step a caller up, and validateApp refuses a higher level. What the gate
 * still enforces: R1 (the level, trivially met), and R3 on the three writes: each writes only the
 * values the caller just heard read back and said yes to. A correction said with the yes ("yes, but
 * Thursday") changes a value, so R3 refuses the write and the summary is read again.
 */
const TOOL_LEVEL: Readonly<Record<ClinicTool, Level>> = {
  findAppointment: 0,
  listOpenings: 0,
  bookAppointment: 0,
  moveAppointment: 0,
  cancelAppointment: 0,
};

const RULES_FOR: Readonly<Record<ClinicTool, readonly string[]>> = {
  findAppointment: ['R1'],
  listOpenings: ['R1'],
  bookAppointment: ['R1', 'R3'],
  moveAppointment: ['R1', 'R3'],
  cancelAppointment: ['R1', 'R3'],
};

/** R3: what a confirmed write carries, in the order the hash is taken over: who, with whom, and when. */
export const CONFIRMED_FIELDS: readonly string[] = ['name', 'dob', 'provider', 'date', 'time'];

export const CLINIC_POLICY: PolicyTables = {
  toolLevel: TOOL_LEVEL,
  purposeLevel: {},
  rulesFor: RULES_FOR,
  serviceFields: {},
  confirmedFields: CONFIRMED_FIELDS,
  maxAttempts: 3,
  subjects: {},
};
