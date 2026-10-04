import type { GateEvent } from '../core/lifecycle';
import { appOf } from '../core/app/registry';
import { goldenRuns, type GoldenClient, type GoldenRunOptions } from './goldenRuns';

/**
 * Gate-event goldens: every decision the action gate makes on an app's regression run, written out
 * line by line, so a change to the policy, the gate or the tables shows as a diff. The regression's
 * own outputs see only the last decision's tool and verdict; a golden sees every event of every turn
 * (probes and refusals included) with its redacted call, purpose, verdict, reason, the level a
 * step-up needs, and each rule's line.
 */

/** A gate event as the golden writes it: a heading line, then one line per rule the gate ran. */
export function gateEventLines(turn: number, event: GateEvent): string[] {
  const d = event.decision;
  const purpose = d.call.purpose === undefined ? '' : ` (${d.call.purpose})`;
  const reason = d.reason === undefined ? '' : ` reason=${d.reason}`;
  const need = d.needLevel === undefined ? '' : ` need=${d.needLevel}`;
  const head = `${turn} ${d.call.tool}${purpose} ${d.verdict}${reason}${need} ${JSON.stringify(d.call.params)}`;
  return [head, ...d.rules.map((r) => `    ${r.id} ${r.pass ? 'pass' : 'FAIL'}  ${r.description}  |  ${r.compared}`)];
}

/** What a golden run wrote and what it counted. */
export interface GateEventGolden {
  /** The golden: per corpus entry and scenario a `# corpus <id>` or `# scenario <id>` line, then its events by turn (0 is the greeting). */
  readonly text: string;
  readonly entries: number;
  readonly turns: number;
  readonly events: number;
  /** Turns a cassette had no answer for (a recorded run must have none). */
  readonly misses: number;
  /**
   * The params the app's own calls carried that their tool does not list (ToolDef.params), as
   * `tool.param`, distinct and sorted: `check` holds only the listed params to being recorded as
   * declared (policy.yaml `audit:`), so an app's golden test expects none. A tool that lists no
   * params is not counted.
   */
  readonly unlistedParams: readonly string[];
}

/** The clients a golden is taken with: the label stubs, and the app's recorded cassette replayed. */
export type GateGoldenClient = GoldenClient;

export type GateEventGoldenOptions = GoldenRunOptions;

/**
 * Runs the default app's corpus and scenarios exactly as `regress` does (goldenRuns.ts) with the
 * stubs or the recorded cassette, and writes every gate event of every turn.
 */
export async function gateEventGolden(kind: GateGoldenClient, options: GateEventGoldenOptions = {}): Promise<GateEventGolden> {
  const runs = await goldenRuns(kind, options);
  const lines: string[] = [];
  let events = 0;
  const unlisted = new Set<string>();
  for (const section of runs.sections) {
    lines.push(`# ${section.heading}`);
    section.runs.forEach((run, i) => {
      const tools = appOf(run.result.session).tools;
      for (const event of run.result.gateEvents) {
        events += 1;
        lines.push(...gateEventLines(i, event));
        const { tool, params } = event.decision.call;
        const listed = Object.hasOwn(tools, tool) ? tools[tool]!.params : undefined;
        if (Array.isArray(listed)) for (const param of Object.keys(params)) if (!listed.includes(param)) unlisted.add(`${tool}.${param}`);
      }
    });
  }
  return {
    text: `${lines.join('\n')}\n`, entries: runs.sections.length, turns: runs.turns, events, misses: runs.misses, unlistedParams: [...unlisted].sort(),
  };
}
