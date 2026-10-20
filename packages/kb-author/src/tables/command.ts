import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from '../args';
import type { Io } from '../cli';
import { WEAK } from '../extract/tables/check';
import { readLabels } from '../extract/tables/labels';
import { scorePdf, type DocumentScore, type Tally } from '../extract/tables/score';

/**
 * kb:tables <labels file | folder>... [--out <file>] [--json]
 *
 * Scores the PDF table readers on documents whose tables a person labelled (`<name>.tables.yaml` beside
 * each document, ../extract/tables/labels.ts): for each table, how many of its cells, whole rows and
 * headings were read right, the checker's score of it, and the first cells read wrong; then the totals,
 * and how many tables the checker calls weak among those read badly and those read well. A folder is
 * searched for labels files. Markdown by default (to stdout, or `--out`), JSON with `--json`. Exit
 * codes: 0 a report written, 1 a problem (a labels file that does not read, a document not found), 2 a
 * command line not understood.
 */

export const TABLES_USAGE = [
  'usage: kb:tables <labels file | folder>... [--out <file>] [--json]',
  '  scores the PDF table readers on documents whose tables a person labelled (<name>.tables.yaml beside each document):',
  '  each table\'s cells, whole rows and headings read right, the checker\'s score of it and the first cells read wrong, then the totals.',
  '  A folder is searched for labels files; --out writes the report to a file; --json prints JSON for tools.',
].join('\n');

/** The labels files under a folder, or the file itself. */
function labelFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  const out: string[] = [];
  for (const name of readdirSync(path).sort()) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(path, name);
    if (statSync(full).isDirectory()) out.push(...labelFiles(full));
    else if (name.endsWith('.tables.yaml')) out.push(full);
  }
  return out;
}

const share = (t: Tally) => `${t.right}/${t.of}${t.of === 0 ? '' : ` (${Math.round((t.right / t.of) * 100)}%)`}`;
const sum = (ts: readonly Tally[]): Tally => ({ right: ts.reduce((n, t) => n + t.right, 0), of: ts.reduce((n, t) => n + t.of, 0) });
const cell = (s: string) => s.replace(/\|/g, '\\|');

/** The scores as Markdown. */
export function formatTables(scores: readonly DocumentScore[]): string[] {
  const all = scores.flatMap((d) => d.tables.map((t) => ({ d, t })));
  const lines = [`# Table readers scored on ${scores.length} labelled document${scores.length === 1 ? '' : 's'}, ${all.length} table${all.length === 1 ? '' : 's'}`, ''];
  lines.push('| Document | Page | Table | Reader | Cells right | Whole rows | Headings | Check |', '|---|---|---|---|---|---|---|---|');
  for (const { d, t } of all) {
    lines.push(`| ${cell(d.document)} | ${t.page} | ${cell(t.name)} | ${t.reader ?? 'not found'} | ${share(t.cells)} | ${share(t.rows)} | ${share(t.heads)} | ${t.check === undefined ? '' : t.check.toFixed(2)} |`);
  }
  const cells = sum(all.map(({ t }) => t.cells));
  lines.push('', `Cells ${share(cells)}; whole rows ${share(sum(all.map(({ t }) => t.rows)))}; headings ${share(sum(all.map(({ t }) => t.heads)))}.`);
  // How the checker sees the tables found and read badly (under half their cells) and those read well.
  const found = all.filter(({ t }) => t.reader !== undefined && t.cells.of > 0);
  const bad = found.filter(({ t }) => t.cells.right / t.cells.of < 0.5);
  const good = found.filter(({ t }) => t.cells.right / t.cells.of >= 0.5);
  const weak = (xs: typeof all) => xs.filter(({ t }) => t.check !== undefined && t.check < WEAK).length;
  lines.push(
    `${all.length - found.length} of the ${all.length} tables were not found (no table read has any of their cells). ` +
      `The checker calls ${weak(bad)} of the ${bad.length} found and read badly (under half their cells right) weak, and ${weak(good)} of the ${good.length} read well.`,
  );
  const missed = all.filter(({ t }) => t.misses.length > 0);
  if (missed.length > 0) {
    lines.push('', '## Cells read wrong (the first of each table)', '');
    for (const { d, t } of missed) {
      lines.push(`- ${d.document} p${t.page} ${t.name}:`);
      for (const m of t.misses) lines.push(`  - "${m.label}": the row read: ${m.row === null ? 'none matched' : `"${m.row.length > 200 ? `${m.row.slice(0, 200)}…` : m.row}"`}`);
    }
  }
  const unseen = scores.flatMap((d) => d.unseen.map((u) => ({ d, u })));
  if (unseen.length > 0) {
    lines.push('', '## Labelled words not in the page\'s text (check the labels)', '');
    for (const { d, u } of unseen) lines.push(`- ${d.document} p${u.page}: ${u.words}`);
  }
  return lines;
}

export async function tablesCommand(args: readonly string[], io: Io): Promise<number> {
  const parsed = parseArgs(args, { values: ['--out'], lists: [], flags: ['--json'] });
  if (typeof parsed === 'string') {
    io.err(`kb:tables: ${parsed}\n${TABLES_USAGE}`);
    return 2;
  }
  if (parsed.positional.length === 0) {
    io.err(`kb:tables: give a labels file or a folder of them\n${TABLES_USAGE}`);
    return 2;
  }
  const files: string[] = [];
  for (const p of parsed.positional) {
    const path = resolve(io.cwd, p);
    if (!existsSync(path)) {
      io.err(`kb:tables: ${p} does not exist`);
      return 1;
    }
    files.push(...labelFiles(path));
  }
  if (files.length === 0) {
    io.err('kb:tables: no labels files (<name>.tables.yaml) found');
    return 1;
  }
  const scores: DocumentScore[] = [];
  for (const file of files) {
    const where = relative(io.cwd, file);
    const labels = readLabels(readFileSync(file, 'utf8'));
    if (typeof labels === 'string') {
      io.err(`kb:tables: ${where}: ${labels}`);
      return 1;
    }
    const document = join(dirname(file), labels.document);
    if (!labels.document.toLowerCase().endsWith('.pdf') || !existsSync(document)) {
      io.err(`kb:tables: ${where}: ${labels.document} is not a PDF beside it`);
      return 1;
    }
    scores.push(await scorePdf(new Uint8Array(readFileSync(document)), labels));
  }
  const text = parsed.flags.has('--json') ? [JSON.stringify(scores, null, 2)] : formatTables(scores);
  const out = parsed.values['--out'];
  if (out !== undefined) {
    writeFileSync(resolve(io.cwd, out), `${text.join('\n')}\n`);
    io.out(`kb:tables: wrote ${out}`);
  } else {
    for (const line of text) io.out(line);
  }
  return 0;
}
