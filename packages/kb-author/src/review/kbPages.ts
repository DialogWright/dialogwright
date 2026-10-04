import type { ApprovalLogLine, KbPassage, KnowledgeBase } from 'dialogwright';
import type { HeldPassage, RejectedDraft, Standing } from './actions';
import { appliesText, editFields, esc, href, page, sectionHtml, tokenField, WHY, type PageContext } from './pages';

/**
 * The review page's Knowledge base tab: what the knowledge base holds, read-mostly, so a reviewer can
 * see it when nothing waits. Every topic with its passages (where each stands today, and who approved
 * it, from the log of approvals), and the drafts rejected (who, when and why). A passage's page shows
 * its answer against the section it was approved over, with its approval; the one change it offers is
 * an edit, checked as a draft is and approved again. A rejected draft's page can return it to the
 * drafts, to be reviewed again.
 */

/** What the Knowledge base tab is drawn from. */
export interface KbView {
  kb: KnowledgeBase;
  /** Today, as an ISO date: what "in force" is read on. */
  today: string;
  passages: readonly HeldPassage[];
  rejected: readonly RejectedDraft[];
}

/** Where a passage stands, as a chip says it. */
const STANDING: Record<Standing, { chip: string; text: string }> = {
  'in-force': { chip: 'pass', text: 'in force' },
  'not-yet': { chip: '', text: 'not yet in force' },
  expired: { chip: '', text: 'expired' },
  unlogged: { chip: WHY.unlogged.chip, text: WHY.unlogged.text },
  'source-changed': { chip: WHY['source-changed'].chip, text: `withheld as stale: ${WHY['source-changed'].text}` },
  'source-gone': { chip: WHY['source-gone'].chip, text: `withheld as stale: ${WHY['source-gone'].text}` },
  edited: { chip: WHY.edited.chip, text: `withheld as stale: ${WHY.edited.text}` },
  unapproved: { chip: WHY.unapproved.chip, text: `withheld: ${WHY.unapproved.text}` },
};

const chipOf = (s: Standing): string => `<span class="chip ${STANDING[s].chip}">${esc(STANDING[s].text)}</span>`;

const inForceText = (effective: { from: string; to?: string }): string => `from ${effective.from}${effective.to ? ` to ${effective.to}` : ', open-ended'}`;

/** Who approved a passage and when: the log's line, else what its file says (not in the log), else none. */
function approvedHtml(p: KbPassage, line: ApprovalLogLine | null): string {
  if (line) return `${esc(line.approvedBy)} (${esc(line.owner)}) on ${esc(line.on)}${line.from === 'migration' ? ' <span class="chip">migrated</span>' : ''}`;
  if (p.approval) return `<span class="muted">not in the log: its approval names ${esc(p.approval.approvedBy)} (${esc(p.approval.owner)}) on ${esc(p.approval.on)}</span>`;
  return '<span class="muted">never approved</span>';
}

/** What a line of the log says was approved. */
const FROM: Record<ApprovalLogLine['from'], string> = {
  pending: 'a draft from kb/pending, approved with kb:approve',
  passage: 'a passage in kb/passages, approved with kb:approve',
  migration: 'carried over by a migration from an earlier format',
};

/** The Knowledge base tab: every topic and its passages, then the rejected drafts. */
export function kbPage(ctx: PageContext, view: KbView): string {
  const { kb } = view;
  const parts: string[] = ['<h1>Knowledge base</h1>'];
  const inForce = view.passages.filter((h) => h.standing === 'in-force').length;
  const topics = Object.values(kb.topics);
  parts.push(
    `<p class="muted">As of ${esc(view.today)}: ${topics.length} ${topics.length === 1 ? 'topic' : 'topics'}, ${view.passages.length} ${view.passages.length === 1 ? 'passage' : 'passages'} (${inForce} in force), ${view.rejected.length} rejected ${view.rejected.length === 1 ? 'draft' : 'drafts'}. A passage's page shows the section it was approved against.</p>`,
  );
  parts.push(`<section aria-labelledby="kb-topics-h"><h2 id="kb-topics-h">Topics (${topics.length})</h2>`);
  topics.forEach((t, i) => {
    const passages = view.passages.filter((h) => h.passage.topic === t.id);
    const rows = passages
      .map(({ passage: p, standing, line }) => {
        const locale = p.locale.toLowerCase() !== kb.defaultLocale.toLowerCase() ? ` <span class="chip">${esc(p.locale)}</span>` : '';
        return `<tr><td class="mono"><a href="${href(ctx, `/passage/${encodeURIComponent(p.id)}`)}">${esc(p.id)}</a>${locale}</td><td class="mono">${esc(p.version)}</td><td>${esc(appliesText(p.applies))}</td><td>${esc(inForceText(p.effective))}</td><td>${esc(p.answer)}</td><td>${chipOf(standing)}</td><td>${approvedHtml(p, line)}</td></tr>`;
      })
      .join('');
    parts.push(`<section class="card" aria-labelledby="kb-t${i}">
  <h3 id="kb-t${i}">${esc(t.title)} <span class="mono muted">${esc(t.id)}</span></h3>
  ${t.accountLine ? `<p class="muted">Account line: ${esc(t.accountLine.text)} (read through ${esc(t.accountLine.from)})</p>` : ''}
  ${
    passages.length === 0
      ? '<p class="muted">No passage answers this topic yet: nothing can be said for it.</p>'
      : `<table><thead><tr><th scope="col">Passage</th><th scope="col">Version</th><th scope="col">For</th><th scope="col">In force</th><th scope="col">Answer</th><th scope="col">State</th><th scope="col">Approved</th></tr></thead><tbody>${rows}</tbody></table>`
  }
  <p class="hint"><a href="${href(ctx, `/topic/${encodeURIComponent(t.id)}`)}">Its keywords, the ways callers ask, and the drafts that answer it</a></p>
</section>`);
  });
  parts.push('</section>');

  parts.push(`<section class="card" aria-labelledby="kb-rejected-h"><h2 id="kb-rejected-h">Rejected drafts (${view.rejected.length})</h2>`);
  if (view.rejected.length === 0) parts.push('<p class="muted">No draft has been rejected.</p>');
  else {
    const rows = view.rejected.map(
      (r) =>
        `<tr><td class="mono"><a href="${href(ctx, `/rejected/${encodeURIComponent(r.id)}`)}">${esc(r.id)}</a></td><td class="mono">${esc(r.draft?.topic ?? '?')}</td><td>${esc(r.rejected?.by ?? '')}</td><td>${esc(r.rejected?.on ?? '')}</td><td>${r.rejected ? esc(r.rejected.reason) : '<span class="muted">its rejection does not read</span>'}</td></tr>`,
    );
    parts.push(`<table><thead><tr><th scope="col">Draft</th><th scope="col">Topic</th><th scope="col">Rejected by</th><th scope="col">On</th><th scope="col">Why</th></tr></thead><tbody>${rows.join('')}</tbody></table>`);
    parts.push('<p class="hint">A rejected draft\'s page can return it to the drafts, to be reviewed again.</p>');
  }
  parts.push('</section>');
  return page(ctx, 'Knowledge base', parts.join('\n'));
}

/** A passage that is not withheld (approved, fresh and logged): its answer, its source and its approval, and an edit that is approved again. */
export function heldPassagePage(ctx: PageContext, kb: KnowledgeBase, held: HeldPassage): string {
  const { passage: p, standing, line } = held;
  const topic = Object.hasOwn(kb.topics, p.topic) ? kb.topics[p.topic] : undefined;
  const source = Object.hasOwn(kb.sources, p.source.document) ? kb.sources[p.source.document] : undefined;
  const can = ctx.reviewer !== null;
  const approval = line
    ? `<dl>
    <dt>Approved by</dt><dd>${esc(line.approvedBy)}</dd>
    <dt>Team</dt><dd>${esc(line.owner)}</dd>
    <dt>On</dt><dd>${esc(line.on)}</dd>
    <dt>Version</dt><dd class="mono">${esc(line.version)}</dd>
    <dt>Recorded as</dt><dd>${esc(FROM[line.from] ?? line.from)}${line.note !== undefined ? ` <span class="muted">(${esc(line.note)})</span>` : ''}</dd>
    <dt>Source hash</dt><dd class="mono">${esc(line.sourceHash.slice(0, 12))}</dd>
    <dt>Hash</dt><dd class="mono">${esc(line.hash.slice(0, 12))}</dd>
  </dl>`
    : p.approval
      ? `<p class="muted">No line of the log of approvals records it (there is no log to hold it to). Its file names ${esc(p.approval.approvedBy)} (${esc(p.approval.owner)}) on ${esc(p.approval.on)}.</p>`
      : '<p class="muted">Never approved.</p>';
  const left = `<section class="card" aria-labelledby="passage-h">
  <h2 id="passage-h">The passage ${chipOf(standing)}</h2>
  <div class="answer" aria-label="The answer">${esc(p.answer)}</div>
  <dl>
    <dt>Topic</dt><dd>${esc(topic?.title ?? p.topic)} <span class="mono muted">${esc(p.topic)}</span></dd>
    ${topic?.accountLine ? `<dt>Account line</dt><dd>${esc(topic.accountLine.text)} <span class="muted">(read through ${esc(topic.accountLine.from)})</span></dd>` : ''}
    <dt>For</dt><dd>${esc(appliesText(p.applies))}</dd>
    <dt>In force</dt><dd>${esc(inForceText(p.effective))}</dd>
    <dt>Version</dt><dd class="mono">${esc(p.version)}</dd>
    ${p.locale.toLowerCase() !== kb.defaultLocale.toLowerCase() ? `<dt>Language</dt><dd class="mono">${esc(p.locale)}${p.translates ? ` <span class="muted">(translates ${esc(p.translates)})</span>` : ''}</dd>` : ''}
    <dt>File</dt><dd class="mono">${esc(p.file)}</dd>
  </dl>
  <form class="action" method="post" action="/passage/${encodeURIComponent(p.id)}/edit">${tokenField(ctx)}
    <h3>Edit, then approve</h3>
    <p class="hint">The edit is checked as a draft is, then approved under your name; if either refuses it, the passage stays as it is.</p>
    ${editFields(kb, { answer: p.answer, applies: p.applies, effective: p.effective }, 'edit')}
    <button class="primary" type="submit"${can ? '' : ' disabled'}>Save the edit and approve</button>
  </form>
</section>`;
  const right = `<section class="card" aria-labelledby="approval-h"><h2 id="approval-h">Its approval</h2>${approval}</section>
<section class="card" aria-labelledby="source-h"><h2 id="source-h">The section it was approved against</h2>${sectionHtml(source, p.source.section, null)}<p class="hint">Unchanged since it was approved: its text hashes to the approval's source hash.</p></section>`;
  return page(ctx, `Passage ${p.id}`, `<h1>Passage <span class="mono">${esc(p.id)}</span></h1><p><a href="${href(ctx, '/kb')}">Knowledge base</a></p><div class="grid">${left}<div>${right}</div></div>`);
}

/** A rejected draft: what it said, who rejected it and why, and its source; it can be returned to the drafts. */
export function rejectedPage(ctx: PageContext, kb: KnowledgeBase | null, r: RejectedDraft): string {
  const can = ctx.reviewer !== null;
  const d = r.draft;
  const rejection = r.rejected ? `<dt>Rejected</dt><dd>by ${esc(r.rejected.by)} on ${esc(r.rejected.on)}: ${esc(r.rejected.reason)}</dd>` : '';
  const about = d
    ? `<div class="answer" aria-label="The drafted answer">${esc(d.answer)}</div>
  <dl>
    <dt>Topic</dt><dd>${esc(kb && Object.hasOwn(kb.topics, d.topic) ? kb.topics[d.topic]!.title : d.topic)} <span class="mono muted">${esc(d.topic)}</span></dd>
    <dt>For</dt><dd>${esc(appliesText(Object.fromEntries(Object.entries(d.applies ?? {}).map(([k, v]) => [k, typeof v === 'string' ? [v] : v]))))}</dd>
    <dt>In force</dt><dd>${esc(inForceText(d.effective))}</dd>
    <dt>Version</dt><dd class="mono">${esc(d.version)}</dd>
    <dt>Drafted</dt><dd>by ${esc(d.drafted.by)} on ${esc(d.drafted.on)}</dd>
    ${rejection}
    <dt>File</dt><dd class="mono">${esc(r.file)}</dd>
  </dl>`
    : `<p role="alert">${esc(r.file)} does not read as a draft.</p>${rejection ? `<dl>${rejection}</dl>` : ''}`;
  const left = `<section class="card" aria-labelledby="rejected-h">
  <h2 id="rejected-h">The rejected draft</h2>
  ${about}
  <form class="action" method="post" action="/rejected/${encodeURIComponent(r.id)}/return">${tokenField(ctx)}
    <h3>Return to drafts</h3>
    <p class="hint">It moves back to kb/pending without its rejection, and waits for review again: nothing is approved.</p>
    <button type="submit"${can ? '' : ' disabled'}>Return to drafts</button>
  </form>
</section>`;
  const right = d && kb ? `<section class="card" aria-labelledby="source-h"><h2 id="source-h">Its source</h2>${sectionHtml(kb.sources[d.source.document], d.source.section, d.drafted.excerpt ?? '')}</section>` : '';
  return page(ctx, `Rejected draft ${r.id}`, `<h1>Rejected draft <span class="mono">${esc(r.id)}</span></h1><p><a href="${href(ctx, '/kb')}">Knowledge base</a></p><div class="grid">${left}${right}</div>`);
}
