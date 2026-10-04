// Every value here is a PLACEHOLDER until tuned against real Jev fixtures
// Change values here or via `--threshold NAME=VALUE`.

export const DEFAULT_THRESHOLDS = {
  // gate ladder
  // 0.70 → 0.65: "Agent" alone scored 0.67 on jev-1.13.0 once timeOfDay joined the opener's
  // questions; the sweep grid gains that one outcome anywhere from 0.55 to 0.65 and loses none, and declined
  // to move on its own, so this is a judgment step like GATE_INTELLIGIBLE's. The trade: "um" scores 0.66, so
  // a filler now gets the open re-ask instead of being ignored, which costs a caller one rung; "Agent" being
  // ignored until the no-input timer is the worse failure.
  GATE_ADDRESSED: 0.65,
  // 0.50 → 0.45: "Agent" alone scored 0.49 on jev-1.13.0; the sweep grid is flat from 0.05 to 0.45 (one
  // outcome better, none worse) and the unbounded-plateau rule declined to move it, so this is a judgment step.
  GATE_INTELLIGIBLE: 0.45,
  GATE_COMPLETE: 0.6,
  GATE_WANTS_HUMAN: 0.7,
  INTENT_ROUTE: 0.7,
  INTENT_IMPLICIT: 0.6,
  INTENT_EXPLICIT: 0.4,
  INTENT_SWITCH: 0.85,
  GATE_INTENT_MARGIN: 0.15,
  GATE_FRUSTRATION_HIGH: 0.6,
  // question redesign
  INTENT_TENTATIVE: 0.5,
  INTENT_CHANGE: 0.6,
  // final confirm
  SLOT_CHANGE: 0.6,
  INTENT_SECOND: 0.6,
  // slots
  SLOT_DETECT: 0.6,
  SLOT_CHOICE_FILL: 0.55,
  SLOT_CHOICE_CONFIRM: 0.45,
  SLOT_CHOICE_MARGIN: 0.15,
  SLOT_HELP: 0.6,
  // knowledge: a topic slot with `disambiguate` asks which of two topics when the model's top two are
  // both topics it may fill and closer than this (slots/topic/fill.ts)
  KB_TOPIC_MARGIN: 0.15,
  // confirmations and menus
  CONFIRM_YES: 0.7,
  CONFIRM_NO: 0.7,
  MENU_NUMBER: 0.7,
  // injection screen: sensitive on purpose: a false positive costs one reprompt
  SCREEN_FIRE: 0.5,
  // retry policy
  MAX_ATTEMPTS: 3,
  // stub and client
  STUB_SHARPNESS: 0.9,
  JEV_TIMEOUT_MS: 1500,
  // With the screen separate (ScreenMode, core/screen.ts; unused inline, where the screen rides in
  // perception's request): how long a turn waits for the screen once perception has answered. The two go out
  // together and the screen's question is the smaller, so it is nearly always back first; a screen
  // later than this is not waited for (it fails open, screen.error 'screen late'). Fixed, not swept.
  SCREEN_GRACE_MS: 300,
  JEV_PRICE_PER_MTOK: 0.042,
} as const;

export type ThresholdName = keyof typeof DEFAULT_THRESHOLDS;
/** The engine's thresholds, and beside them any the app names (App.thresholds), read by name. */
export type Thresholds = { -readonly [K in ThresholdName]: number } & Readonly<Record<string, number>>;

export function withOverrides(overrides: Partial<Thresholds>): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...overrides };
}

/**
 * `t` with the app's own thresholds (App.thresholds) under it: a name `t` already holds (an override)
 * keeps its value, and the rest take the app's defaults. `t` itself for an app without any.
 */
export function withAppThresholds(t: Thresholds, own: Readonly<Record<string, number>> | undefined): Thresholds {
  return own ? { ...own, ...t } : t;
}

/** One `NAME=VALUE` override: an engine threshold's name, or one of `own` (the app's, App.thresholds). */
export function parseOverride(spec: string, own?: Readonly<Record<string, number>>): Partial<Thresholds> {
  const parts = spec.split('=');
  if (parts.length !== 2) throw new Error(`bad threshold override: ${spec}`);
  const [name, raw] = parts;
  if (!name) throw new Error(`bad threshold override: ${spec}`);
  if (!Object.hasOwn(DEFAULT_THRESHOLDS, name) && !(own && Object.hasOwn(own, name))) throw new Error(`unknown threshold: ${name}`);
  if (!raw || !raw.trim()) throw new Error(`bad threshold value: ${spec}`);
  const value = Number(raw);
  if (Number.isNaN(value)) throw new Error(`bad threshold value: ${spec}`);
  return { [name]: value } as Partial<Thresholds>;
}

/**
 * Slack for comparing a model's probability to a threshold. The probabilities arrive as decimals and
 * are sometimes summed or subtracted (a margin), so a value that is 0.4 on paper can be
 * 0.39999999999999997 in a double and would fail a 0.4 gate it meets. Far below any difference the
 * model's two-decimal probabilities can express.
 */
export const THRESHOLD_EPSILON = 1e-9;

/** Whether `value` reaches `threshold` (value >= threshold), allowing for floating-point rounding. */
export function atLeast(value: number, threshold: number): boolean {
  return value >= threshold - THRESHOLD_EPSILON;
}
