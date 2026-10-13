import type { PolicyTables } from 'dialogwright/policy';

/**
 * The clinic's tables as they were when its policy.yaml was written in the old shape
 * (./legacy/policy.yaml): frozen test data. policy.yaml in the new shape must compile to exactly
 * this (../policyFile.test.ts), and the gate must decide every case over it as over the compiled
 * tables. The clinic has no identity.yaml, so maxAttempts is the engine's default. answerQuestion came
 * later, with the knowledge base (2026-10-13): it is written here, and in ./legacy/policy.yaml, as the
 * old shape would have held it (level 0, R1), so the comparison with the legacy evaluator stays over
 * every tool the clinic has.
 */
export const FROZEN_CLINIC_POLICY: PolicyTables = {
  toolLevel: { findAppointment: 0, listOpenings: 0, bookAppointment: 0, moveAppointment: 0, cancelAppointment: 0, answerQuestion: 0 },
  purposeLevel: {},
  rulesFor: {
    findAppointment: ['R1'],
    listOpenings: ['R1'],
    bookAppointment: ['R1', 'R3'],
    moveAppointment: ['R1', 'R3'],
    cancelAppointment: ['R1', 'R3'],
    answerQuestion: ['R1'],
  },
  serviceFields: {},
  confirmedFields: ['name', 'dob', 'provider', 'date', 'time'],
  maxAttempts: 3,
  subjects: {},
};
