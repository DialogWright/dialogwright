import { unsupportedCheck } from '../parts/check';

/**
 * A reference value is not taken from outside the slot's fill: what it holds is an entry of the app's own
 * data, chosen by the model among what the code offered, so a value cited by an agent is `unsupported`.
 */
export const referenceCheck = unsupportedCheck;
