import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { z } from 'zod';
import { envVariableOf } from '../../core/app/envReference';
import { problemsOfIssues, type Problem } from '../../define/problems';
import type { JsonSchema } from '../../define/schema/json';
import { agentBusinessSchema, type AgentBusiness } from './schema';

/** The business file of an app. */
export const AGENT_FILE = 'agent.yaml';

/** The first line every agent.yaml starts with, so an editor completes and checks it. */
export const AGENT_SCHEMA_LINE = /^# yaml-language-server: \$schema=\S*schemas\/agent\.schema\.json\s*$/;

/** agent.yaml could not be read; `problems` say where and how to fix each, as `pnpm check` prints them. */
export class AgentBusinessError extends Error {
  constructor(readonly problems: Problem[]) {
    super(problems.map((p) => `${p.file}:${p.line}:${p.column}  ${p.path}  ${p.message}  ->  ${p.fix}`).join('\n'));
    this.name = 'AgentBusinessError';
  }
}

/** The problems of agent.yaml's text: syntax, then every schema issue, each at its line with a fix. */
export function agentBusinessProblems(text: string, file: string = AGENT_FILE): { problems: Problem[]; value?: AgentBusiness } {
  const lines = new LineCounter();
  const doc = parseDocument(text, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, prettyErrors: false, logLevel: 'error', lineCounter: lines, customTags: [] });
  const problems: Problem[] = [];
  for (const e of doc.errors) {
    const at = lines.linePos(e.pos[0]);
    problems.push({ file, line: at.line, column: at.col, path: '(file)', message: e.message.split('\n')[0] ?? e.message, fix: 'correct the YAML at this position (the files are YAML 1.2)' });
  }
  if (problems.length > 0) return { problems };
  const raw = doc.toJS();
  if (raw === null || raw === undefined) {
    return { problems: [{ file, line: 1, column: 1, path: '(file)', message: `${file} is empty`, fix: 'add its content: "business:", "persona:", "lines:", "model:" and "actions:"' }] };
  }
  const parsed = agentBusinessSchema.safeParse(raw);
  if (parsed.success) return { problems: [], value: parsed.data };
  const schema = z.toJSONSchema(agentBusinessSchema, { io: 'input', target: 'draft-7' }) as JsonSchema;
  return { problems: problemsOfIssues(parsed.error.issues, { file, doc, lines, value: raw, schema }) };
}

/** The problem of a file that does not start with the schema line, or null. */
export function agentSchemaLineProblem(text: string, file: string = AGENT_FILE): Problem | null {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  if (AGENT_SCHEMA_LINE.test(first)) return null;
  return {
    file,
    line: 1,
    column: 1,
    path: '(file)',
    message: `${file} does not start with the schema line`,
    fix: 'make the first line "# yaml-language-server: $schema=<relative path>/packages/dialogwright/schemas/agent.schema.json", so an editor completes and checks the file',
  };
}

/** `env.<NAME>` read from `env`; a plain value as it is; undefined when the variable is unset. */
function resolved(value: string, env: Record<string, string | undefined>): string | undefined {
  const variable = envVariableOf(value);
  if (variable === null) return value;
  const v = env[variable]?.trim();
  return v === undefined || v === '' ? undefined : v;
}

/**
 * The business of the app folder `dir` (its agent.yaml), with `env.<NAME>` numbers read from `env`. An
 * account's number whose variable is unset is left out (the account is recognised by its other numbers);
 * a transfer number whose variable is unset is an error. Throws AgentBusinessError, whose message is
 * `pnpm check`'s own lines.
 */
export function loadAgentBusiness(dir: string, env: Record<string, string | undefined> = process.env): AgentBusiness {
  let text: string;
  try {
    text = readFileSync(join(dir, AGENT_FILE), 'utf8');
  } catch {
    throw new AgentBusinessError([{ file: AGENT_FILE, line: 1, column: 1, path: '(file)', message: `${AGENT_FILE} cannot be read in ${dir}`, fix: `create ${AGENT_FILE} there` }]);
  }
  const { problems, value } = agentBusinessProblems(text);
  if (!value) throw new AgentBusinessError(problems);
  const accounts = value.sources.accounts?.map((a) => ({
    ...a,
    numbers: a.numbers.flatMap((n) => {
      const r = resolved(n, env);
      return r === undefined ? [] : [r];
    }),
  }));
  let transfer = value.transfer;
  if (transfer) {
    const number = resolved(transfer.number, env);
    if (number === undefined) {
      throw new AgentBusinessError([{ file: AGENT_FILE, line: 1, column: 1, path: 'transfer.number', message: `${transfer.number} names a setting that is not set`, fix: `set ${envVariableOf(transfer.number)} to the number in the app's settings (.env)` }]);
    }
    transfer = { number };
  }
  return { ...value, sources: { ...value.sources, ...(accounts ? { accounts } : {}) }, ...(transfer ? { transfer } : {}) };
}
