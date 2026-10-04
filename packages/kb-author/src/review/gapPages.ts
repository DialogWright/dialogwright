import type { KnowledgeBase } from 'dialogwright';
import type { DraftOnDisk } from '../draft/draft';
import { groupName, kindsText, sampleLabel, type Fix, type GapGroup, type GapReport } from '../gaps/report';
import type { Withheld } from './actions';
import { esc, href, page, type PageContext } from './pages';

/**
 * The review page's Gaps tab: what callers asked that the knowledge base did not answer, ranked
 * (../gaps/report.ts), with a link from each fix to the page where it is done: a stale passage to its
 * withheld page, a topic to its passages and drafts, and "draft from" to the source sections nothing
 * cites that read as relevant. It reads the traces each time it is opened, so it shows what the
 * calls since have added. The callers' words are the traces' as recorded, as private as the traces.
 */

/** What the Gaps pages are drawn from. */
export interface GapsView {
  report: GapReport;
  kb: KnowledgeBase;
  /** The passages withheld now, by id: a link to a passage's page is only made for one of these. */
  withheld: ReadonlySet<string>;
  /** The topics a draft proposes, by id (their page is the proposed topic's). */
  proposed: ReadonlySet<string>;
  /** Where the traces were looked for, as the command names them. */
  searched: readonly string[];
}

const gapPath = (key: string): string => `/gaps/${encodeURIComponent(key)}`;

/** The link from a fix to where it is done, when there is a page for it. */
function fixLinks(ctx: PageContext, view: GapsView, g: GapGroup, f: Fix): string {
  const links: string[] = [];
  if (f.id === 're-approve' && f.passage !== undefined && view.withheld.has(f.passage)) links.push(`<a href="${href(ctx, `/passage/${encodeURIComponent(f.passage)}`)}">review passage <span class="mono">${esc(f.passage)}</span></a>`);
  if (f.id === 'draft-from-section') links.push(`<a href="${href(ctx, gapPath(g.key))}">draft from ${g.draftFrom.length === 1 ? '1 section' : `${g.draftFrom.length} sections`}</a>`);
  for (const t of f.topics ?? []) {
    if (Object.hasOwn(view.kb.topics, t) || view.proposed.has(t)) links.push(`<a href="${href(ctx, `/topic/${encodeURIComponent(t)}`)}">passages and drafts of <span class="mono">${esc(t)}</span></a>`);
  }
  return links.length === 0 ? '' : `<br><span class="muted">${links.join(' &middot; ')}</span>`;
}

function groupCard(ctx: PageContext, view: GapsView, g: GapGroup, rank: number, detail: boolean): string {
  const heading = g.known || view.proposed.has(g.topic ?? '') ? `<a href="${href(ctx, `/topic/${encodeURIComponent(g.topic!)}`)}">${esc(groupName(g))}</a>` : esc(groupName(g));
  const samples =
    g.samples.length === 0
      ? '<p class="muted">No words to show.</p>'
      : `<ul>${g.samples.map((s) => `<li><q>${esc(s.words)}</q> <span class="chip">${esc(sampleLabel(s))}</span> <span class="muted">${esc(s.ts.slice(0, 10))}</span></li>`).join('')}</ul>`;
  const withheld = g.withheld > 0 ? `<p class="hint">${g.withheld} not shown: the caller gave a value the trace masks.</p>` : '';
  const fixes = `<ul>${g.fixes.map((f) => `<li>${esc(f.text)}${f.count > 1 ? ` <span class="muted">(${f.count})</span>` : ''}${fixLinks(ctx, view, g, f)}</li>`).join('')}</ul>`;
  const more = detail ? '' : g.draftFrom.length > 0 ? `<p><a href="${href(ctx, gapPath(g.key))}">All the callers' words, and ${g.draftFrom.length === 1 ? 'the section' : 'the sections'} to draft from</a></p>` : `<p><a href="${href(ctx, gapPath(g.key))}">All the callers' words</a></p>`;
  return `<section class="card" aria-labelledby="g${rank}">
  <h2 id="g${rank}">${rank}. ${heading} <span class="chip ${g.count >= 5 ? 'warn' : ''}">${g.count} ${g.count === 1 ? 'gap' : 'gaps'}</span></h2>
  <p class="muted">${esc(kindsText(g))}. Latest ${esc(g.latest.slice(0, 10))}.${g.near === 'keyword' ? ' Nearest by keywords: retrieval nominated nothing.' : ''}</p>
  <h3>Callers said</h3>
  ${samples}${withheld}
  <h3>Fix</h3>
  ${fixes}
  ${more}
</section>`;
}

/** The Gaps tab: the ranked groups. */
export function gapsPage(ctx: PageContext, view: GapsView): string {
  const r = view.report;
  const t = r.traces;
  const parts: string[] = [`<h1>Gaps</h1>`];
  if (t.files === 0) {
    parts.push(
      `<section class="card" role="alert"><h2>No trace files found</h2><p>Looked in ${view.searched.map((s) => `<span class="mono">${esc(s)}</span>`).join(', ')}. A server writes traces to <span class="mono">TRACE_DIR</span> (default <span class="mono">traces</span>); start the review page with <span class="mono">--traces &lt;path|glob&gt;</span> to read them from elsewhere.</p></section>`,
    );
    return page(ctx, 'Gaps', parts.join('\n'));
  }
  parts.push(
    `<p class="muted">${r.gaps} ${r.gaps === 1 ? 'gap' : 'gaps'} in ${r.groups.length} ${r.groups.length === 1 ? 'group' : 'groups'}, from ${t.turns} ${t.turns === 1 ? 'turn' : 'turns'} in ${t.calls} ${t.calls === 1 ? 'call' : 'calls'} (${t.files} trace ${t.files === 1 ? 'file' : 'files'}${t.from !== null ? `, ${esc(t.from === t.to ? t.from : `${t.from} to ${t.to}`)}` : ''}). The callers' words are the traces' own: keep this page as private as they are.</p>`,
  );
  if (t.retrievalFailed > 0) parts.push(`<p class="hint">${t.retrievalFailed} ${t.retrievalFailed === 1 ? 'turn' : 'turns'} nominated nothing because retrieval failed: not counted as gaps.</p>`);
  if (r.groups.length === 0) parts.push(`<section class="card"><p>${t.turns === 0 ? 'No turns were read: nothing to rank.' : 'No gaps: every question callers asked was answered from the knowledge base, or was not a question for it.'}</p></section>`);
  r.groups.forEach((g, i) => parts.push(groupCard(ctx, view, g, i + 1, false)));
  return page(ctx, 'Gaps', parts.join('\n'));
}

/** One group, with every sample and the source sections that read as relevant. */
export function gapGroupPage(ctx: PageContext, view: GapsView, g: GapGroup): string {
  const sections =
    g.draftFrom.length === 0
      ? '<p class="muted">No section that nothing cites reads as relevant: ingest a source that covers it (pnpm kb:ingest), or write the passage by hand.</p>'
      : `<ul>${g.draftFrom
          .map((d) => {
            const section = view.kb.sources[d.document]?.sections[d.section];
            const text = section?.text ?? '';
            return `<li><span class="mono">${esc(d.document)} / ${esc(d.section)}</span>${d.heading !== null ? ` (${esc(d.heading)})` : ''}<div class="section-text" tabindex="0" aria-label="The section's text">${esc(text.length > 600 ? `${text.slice(0, 600)}...` : text)}</div></li>`;
          })
          .join('')}</ul><p class="hint">Run <span class="mono">pnpm kb:draft ${g.draftFrom.map((d) => `--source ${esc(d.document)}`).filter((v, i, a) => a.indexOf(v) === i).join(' ')}</span> to draft from these (it uses your own key); the drafts then wait on the review page.</p>`;
  const body = `<h1>${esc(groupName(g))}</h1>
<p><a href="${href(ctx, '/gaps')}">All gaps</a></p>
${groupCard(ctx, view, g, 1, true)}
<section class="card" aria-labelledby="from-h"><h2 id="from-h">Draft from: sections nothing cites that read as relevant</h2>${sections}</section>`;
  return page(ctx, `Gaps: ${groupName(g)}`, body);
}

/** A topic the knowledge base has: its words, its passages (a withheld one links to its page) and the drafts that answer it. */
export function kbTopicPage(ctx: PageContext, kb: KnowledgeBase, topicId: string, withheld: readonly Withheld[], drafts: readonly DraftOnDisk[]): string {
  const t = kb.topics[topicId]!;
  const held = new Map(withheld.map((w) => [w.passage.id, w]));
  const passages = Object.values(kb.passages).filter((p) => p.topic === topicId);
  const list = (items: readonly string[]): string => (items.length === 0 ? '<span class="muted">none</span>' : `<ul class="problems">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`);
  const rows = passages
    .map((p) => {
      const w = held.get(p.id);
      const state = w ? `<span class="chip warn">withheld</span> <a href="${href(ctx, `/passage/${encodeURIComponent(p.id)}`)}">review</a>` : '<span class="chip pass">approved</span>';
      return `<tr><td class="mono">${esc(p.id)}</td><td>${esc(p.locale)}</td><td>${esc(Object.entries(p.applies).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') || 'every caller')}</td><td>from ${esc(p.effective.from)}${p.effective.to ? ` to ${esc(p.effective.to)}` : ', open-ended'}</td><td>${state}</td></tr>`;
    })
    .join('');
  const body = `<h1>Topic <span class="mono">${esc(topicId)}</span></h1>
<p><a href="${href(ctx, '/gaps')}">Gaps</a></p>
<div class="grid">
<section class="card" aria-labelledby="kt-h"><h2 id="kt-h">The topic</h2>
  <dl><dt>Title</dt><dd>${esc(t.title)}</dd><dt>Keywords</dt><dd>${list(t.keywords)}</dd><dt>Callers ask</dt><dd>${list(t.asks)}</dd></dl>
  <p class="hint">Keywords and asks are in kb/topics.yaml; add the way callers put it there, then run pnpm kb:index when kb.yaml names an embedder.</p>
</section>
<section class="card" aria-labelledby="kp-h"><h2 id="kp-h">Passages (${passages.length})</h2>
  ${passages.length === 0 ? '<p class="muted">No passage answers this topic yet: nothing can be said for it.</p>' : `<table><thead><tr><th scope="col">Passage</th><th scope="col">Language</th><th scope="col">For</th><th scope="col">In force</th><th scope="col">State</th></tr></thead><tbody>${rows}</tbody></table>`}
  <h2>Drafts that answer it (${drafts.length})</h2>
  ${drafts.length === 0 ? '<p class="muted">None waits.</p>' : `<ul>${drafts.map((d) => `<li><a class="mono" href="${href(ctx, `/draft/${encodeURIComponent(d.id)}`)}">${esc(d.id)}</a>: ${esc(d.draft?.answer ?? '')}</li>`).join('')}</ul>`}
</section>
</div>`;
  return page(ctx, `Topic ${topicId}`, body);
}
