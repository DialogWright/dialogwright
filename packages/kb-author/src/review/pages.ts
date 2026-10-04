import type { KbPassage, KbSourceDocument, KnowledgeBase } from 'dialogwright';
import type { DraftOnDisk } from '../draft/draft';
import type { ProposedTopic } from '../draft/drafter';
import type { ActionResult, Reviewer, ReviewState, Withheld } from './actions';
import { excerptRange, wordDiff } from './text';

/**
 * The review page's HTML: plain server-rendered pages, so every list, draft, source and diff reads
 * without JavaScript; the actions are ordinary forms (a little script only asks before a reject). It
 * looks like the operator console (its colours and type), loads nothing from anywhere else, and every
 * form field has a label. Every link and form carries the session's token.
 */

/** Text made safe for HTML. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** What every page is drawn with. */
export interface PageContext {
  token: string;
  nonce: string;
  label: string;
  reviewer: Reviewer | null;
  flash: ActionResult | null;
  /** The path of the page, for the reviewer form to come back to. */
  path: string;
  /** A hash of what the page shows of its draft, passage or topic: every form that changes it carries it back. */
  seen?: string;
}

const STYLE = `
  :root {
    --bg:#0d1016; --panel:#141922; --panel-2:#1a202b; --border:#262e3b; --border-2:#323b4b;
    --text:#e2e6ee; --muted:#8e97aa; --faint:#5f687b; --accent:#5b8def;
    --pass:#3ecf8e; --pass-bg:rgba(62,207,142,.12); --fail:#f26470; --fail-bg:rgba(242,100,112,.13);
    --warn:#f2b54a; --warn-bg:rgba(242,181,74,.13); --idle:#6b7385; --idle-bg:rgba(107,115,133,.12);
    --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace;
  }
  html { font-size:16px; }
  html, body { margin:0; background:var(--bg); color:var(--text); }
  body { font:1rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; -webkit-font-smoothing:antialiased; }
  a { color:#a8c7ff; }
  a:focus-visible, button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .skip { position:absolute; left:-999px; top:8px; background:var(--panel-2); padding:6px 12px; border-radius:6px; }
  .skip:focus { left:16px; }
  .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  header { min-height:64px; display:flex; flex-wrap:wrap; align-items:center; gap:20px; padding:0 24px; border-bottom:1px solid var(--border); background:#0f131a; }
  .brand { display:flex; align-items:center; gap:12px; font-weight:600; }
  .brand .mark { width:30px; height:30px; border-radius:8px; background:linear-gradient(135deg,#2f5fb8,#1d3d7a); display:grid; place-items:center; font-size:13px; font-weight:700; color:#dfe9ff; }
  .brand .title span { color:var(--muted); font-weight:500; }
  header nav { margin-left:auto; display:flex; gap:16px; align-items:center; }
  .badge { display:inline-flex; align-items:center; gap:8px; padding:4px 12px; border-radius:999px; border:1px solid var(--border-2); background:var(--panel-2); font-size:.93em; }
  .badge .k { color:var(--muted); }
  main { padding:20px 24px 48px; max-width:1500px; }
  h1 { font-size:1.35em; margin:.2em 0 .8em; }
  h2 { font-size:.78em; letter-spacing:.09em; text-transform:uppercase; color:var(--muted); font-weight:600; margin:0 0 .7em; }
  h3 { font-size:1em; margin:.2em 0 .5em; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:12px; padding:1em 1.15em; margin-bottom:16px; }
  .grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; align-items:start; }
  @media (max-width: 900px) { .grid { grid-template-columns:1fr; } }
  table { width:100%; border-collapse:collapse; }
  caption { text-align:left; }
  th, td { text-align:left; padding:.45em .6em; border-bottom:1px solid var(--border); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:.9em; }
  .mono { font-family:var(--mono); font-size:.92em; }
  .muted { color:var(--muted); }
  .chip { display:inline-block; padding:1px 9px; border-radius:999px; font-size:.82em; border:1px solid var(--border-2); background:var(--idle-bg); color:var(--muted); }
  .chip.warn { background:var(--warn-bg); color:var(--warn); border-color:rgba(242,181,74,.4); }
  .chip.fail { background:var(--fail-bg); color:var(--fail); border-color:rgba(242,100,112,.4); }
  .chip.pass { background:var(--pass-bg); color:var(--pass); border-color:rgba(62,207,142,.4); }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:.35em 1em; margin:0; }
  dt { color:var(--muted); }
  dd { margin:0; }
  .answer { font-size:1.12em; background:var(--panel-2); border-left:3px solid var(--accent); padding:.6em .9em; border-radius:6px; margin:.3em 0 .9em; }
  .section-text { white-space:pre-wrap; background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:.8em 1em; }
  mark { background:rgba(242,181,74,.28); color:var(--text); border-radius:3px; padding:0 1px; box-shadow:0 0 0 1px rgba(242,181,74,.5); }
  del { background:var(--fail-bg); color:#ffb3b9; text-decoration:line-through; }
  ins { background:var(--pass-bg); color:#9ff0c9; text-decoration:none; }
  .flash { padding:.7em 1em; border-radius:8px; margin-bottom:16px; border:1px solid; }
  .flash.ok { background:var(--pass-bg); border-color:rgba(62,207,142,.45); }
  .flash.no { background:var(--fail-bg); border-color:rgba(242,100,112,.45); }
  .problems { margin:.4em 0 0; padding-left:1.2em; }
  form.action { margin:.9em 0 0; padding-top:.9em; border-top:1px solid var(--border); }
  label { display:block; color:var(--muted); font-size:.92em; margin:.6em 0 .25em; }
  fieldset { border:1px solid var(--border); border-radius:8px; margin:.6em 0; padding:.4em .8em .7em; }
  legend { color:var(--muted); font-size:.92em; padding:0 .3em; }
  fieldset label { display:inline-flex; gap:.35em; align-items:center; margin:.2em 1em 0 0; color:var(--text); }
  input, textarea, select, button { font:inherit; font-size:.95em; background:#1f2632; color:var(--text); border:1px solid var(--border-2); border-radius:7px; padding:6px 10px; }
  textarea { width:100%; box-sizing:border-box; min-height:5em; }
  input[type=text] { width:100%; box-sizing:border-box; }
  input[type=checkbox] { padding:0; }
  button { cursor:pointer; margin-top:.7em; }
  button:hover { border-color:#46526a; }
  button.primary { border-color:var(--accent); background:#1c2a44; color:#d6e3ff; }
  button.danger { border-color:rgba(242,100,112,.6); color:#ffb3b9; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .hint { color:var(--faint); font-size:.88em; margin:.3em 0 0; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .row > div { flex:1; min-width:10em; }
`;

/** A link inside the review page, carrying the token. */
export const href = (ctx: PageContext, path: string): string => `${path}?token=${encodeURIComponent(ctx.token)}`;

/** The token as a form's hidden field, and what the page shows (seen) when it shows a draft, a passage or a topic. */
const tokenField = (ctx: PageContext): string => `<input type="hidden" name="token" value="${esc(ctx.token)}">${ctx.seen !== undefined ? `<input type="hidden" name="seen" value="${esc(ctx.seen)}">` : ''}`;

/** A whole page. */
export function page(ctx: PageContext, title: string, body: string): string {
  const who = ctx.reviewer
    ? `<span class="badge" aria-label="Reviewing as ${esc(ctx.reviewer.by)} for ${esc(ctx.reviewer.owner)}"><span class="k">Reviewer</span> ${esc(ctx.reviewer.by)} <span class="k">for</span> ${esc(ctx.reviewer.owner)}</span>`
    : '<span class="badge"><span class="k">Reviewer</span> not set</span>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${esc(title)}: knowledge base review</title>
<style nonce="${ctx.nonce}">${STYLE}</style>
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<header>
  <div class="brand"><span class="mark" aria-hidden="true">DW</span><span class="title">Knowledge base review <span>${esc(ctx.label)}</span></span></div>
  <nav aria-label="Review"><a href="${href(ctx, '/')}">Everything waiting</a><a href="${href(ctx, '/gaps')}">Gaps</a>${who}</nav>
</header>
<main id="main">
${flashHtml(ctx)}${ctx.reviewer ? '' : reviewerForm(ctx)}${body}
</main>
<script nonce="${ctx.nonce}">
  for (const form of document.querySelectorAll('form[data-confirm]')) {
    form.addEventListener('submit', (event) => { if (!confirm(form.dataset.confirm)) event.preventDefault(); });
  }
</script>
</body>
</html>
`;
}

function flashHtml(ctx: PageContext): string {
  const f = ctx.flash;
  if (!f) return '';
  const problems = !f.ok && f.problems.length > 0 ? `<ul class="problems">${f.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '';
  return `<div class="flash ${f.ok ? 'ok' : 'no'}" role="${f.ok ? 'status' : 'alert'}">${f.ok ? '' : '<strong>Not done:</strong> '}${esc(f.message)}${problems}</div>\n`;
}

function reviewerForm(ctx: PageContext): string {
  return `<section class="card" aria-labelledby="who">
  <h2 id="who">Who is reviewing</h2>
  <p class="muted">An approval records the person who read each answer against its source and answers for it, and the team that owns the content. You are asked once in this browser while this page runs.</p>
  <form method="post" action="/reviewer">
    ${tokenField(ctx)}<input type="hidden" name="back" value="${esc(ctx.path)}">
    <div class="row">
      <div><label for="reviewer-name">Your name</label><input id="reviewer-name" name="by" type="text" autocomplete="name" required></div>
      <div><label for="reviewer-team">Your team (owns the content)</label><input id="reviewer-team" name="owner" type="text" required></div>
    </div>
    <button class="primary" type="submit">Start reviewing</button>
  </form>
</section>
`;
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

const WHY: Record<Withheld['why'], { chip: string; text: string }> = {
  'source-changed': { chip: 'warn', text: 'its source section changed' },
  'source-gone': { chip: 'fail', text: 'its source section is gone' },
  edited: { chip: 'warn', text: 'edited since it was approved' },
  unapproved: { chip: '', text: 'never approved' },
  unlogged: { chip: 'warn', text: 'approved outside kb:approve' },
};

export function indexPage(ctx: PageContext, state: ReviewState, draftProblems: (d: DraftOnDisk) => string[]): string {
  const parts: string[] = [];
  const total = state.drafts.length + state.withheld.length + state.proposed.length;
  parts.push(`<h1>${total === 0 ? 'Nothing waits for review' : `${total} waiting for review`}</h1>`);
  if (!state.kb) {
    parts.push(`<section class="card" role="alert"><h2>The knowledge base does not load</h2><p>Nothing can be approved until it does. Fix these first (pnpm check lists them too):</p><ul class="problems">${state.problems.map((p) => `<li class="mono">${esc(p)}</li>`).join('')}</ul></section>`);
  }
  if (state.proposedProblems.length > 0) parts.push(`<section class="card" role="alert"><h2>Proposed topics</h2><ul class="problems">${state.proposedProblems.map((p) => `<li class="mono">${esc(p)}</li>`).join('')}</ul></section>`);

  parts.push(`<section class="card" aria-labelledby="topics-h"><h2 id="topics-h">Proposed topics (${state.proposed.length})</h2>`);
  if (state.proposed.length === 0) parts.push('<p class="muted">No topic waits: drafts answer topics the knowledge base has.</p>');
  else {
    parts.push('<table><thead><tr><th scope="col">Topic</th><th scope="col">Title</th><th scope="col">Drafts that answer it</th></tr></thead><tbody>');
    for (const t of state.proposed) {
      const n = state.drafts.filter((d) => d.draft?.topic === t.id).length;
      parts.push(`<tr><td class="mono"><a href="${href(ctx, `/topic/${encodeURIComponent(t.id)}`)}">${esc(t.id)}</a></td><td>${esc(t.title)}</td><td>${n}</td></tr>`);
    }
    parts.push('</tbody></table><p class="hint">Accept a topic (or merge it into one the knowledge base has) before approving its drafts.</p>');
  }
  parts.push('</section>');

  parts.push(`<section class="card" aria-labelledby="drafts-h"><h2 id="drafts-h">Drafts waiting (${state.drafts.length})</h2>`);
  if (state.drafts.length === 0) parts.push('<p class="muted">No draft waits. pnpm kb:draft writes drafts here.</p>');
  else {
    parts.push('<table><thead><tr><th scope="col">Draft</th><th scope="col">Topic</th><th scope="col">Answer</th><th scope="col">From</th><th scope="col">State</th></tr></thead><tbody>');
    for (const d of state.drafts) {
      const problems = draftProblems(d);
      const state2 = problems.length === 0 ? '<span class="chip pass">ready</span>' : `<span class="chip warn">${problems.length} to fix</span>`;
      parts.push(
        `<tr><td class="mono"><a href="${href(ctx, `/draft/${encodeURIComponent(d.id)}`)}">${esc(d.id)}</a></td><td class="mono">${esc(d.draft?.topic ?? '?')}</td><td>${esc(d.draft?.answer ?? '(does not read as a draft)')}</td><td class="mono">${d.draft ? `${esc(d.draft.source.document)} / ${esc(d.draft.source.section)}` : ''}</td><td>${state2}</td></tr>`,
      );
    }
    parts.push('</tbody></table>');
  }
  parts.push('</section>');

  const passageRows = (list: readonly Withheld[]): string => {
    const rows = list.map((w) => {
      const why = WHY[w.why];
      return `<tr><td class="mono"><a href="${href(ctx, `/passage/${encodeURIComponent(w.passage.id)}`)}">${esc(w.passage.id)}</a></td><td class="mono">${esc(w.passage.topic)}</td><td><span class="chip ${why.chip}">${esc(why.text)}</span></td><td class="mono">${esc(w.passage.source.document)} / ${esc(w.passage.source.section)}</td></tr>`;
    });
    return `<table><thead><tr><th scope="col">Passage</th><th scope="col">Topic</th><th scope="col">Why</th><th scope="col">Source</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  };
  const held = state.withheld.filter((w) => w.why !== 'unlogged');
  const unlogged = state.withheld.filter((w) => w.why === 'unlogged');
  parts.push(`<section class="card" aria-labelledby="withheld-h"><h2 id="withheld-h">Passages withheld from callers (${held.length})</h2>`);
  if (held.length === 0) parts.push(`<p class="muted">Every passage is approved and fresh.</p>`);
  else parts.push(passageRows(held));
  parts.push('</section>');
  if (unlogged.length > 0) {
    parts.push(`<section class="card" aria-labelledby="unlogged-h"><h2 id="unlogged-h">Passages approved outside kb:approve (${unlogged.length})</h2>`);
    parts.push('<p class="hint">Their approvals have no line in the log of approvals, so no one is on record for them and pnpm check refuses them. Review each against its source and approve it here.</p>');
    parts.push(passageRows(unlogged));
    parts.push('</section>');
  }
  return page(ctx, 'Everything waiting', parts.join('\n'));
}

// ---------------------------------------------------------------------------------------------
// One draft, one passage, one topic
// ---------------------------------------------------------------------------------------------

/** A source section, its excerpt marked. */
function sectionHtml(source: KbSourceDocument | undefined, sectionId: string, excerpt: string | null): string {
  if (!source) return '<p role="alert">The source document is not in kb/sources.</p>';
  const section = Object.hasOwn(source.sections, sectionId) ? source.sections[sectionId]! : undefined;
  const where = source.provenance?.url ?? source.provenance?.file;
  const head = `<h3>${esc(source.document)}</h3><dl><dt>Section</dt><dd class="mono">${esc(sectionId)}${section?.heading ? ` <span class="muted">(${esc(section.heading)})</span>` : ''}</dd>${where ? `<dt>From</dt><dd class="mono">${source.provenance?.url ? `<a href="${esc(source.provenance.url)}" rel="noreferrer noopener" target="_blank">${esc(where)}</a>` : esc(where)}</dd>` : ''}${section?.page !== undefined ? `<dt>Page</dt><dd>${section.page}${section.lastPage !== undefined ? ` to ${section.lastPage}` : ''}</dd>` : ''}${source.provenance?.retrieved ? `<dt>Read on</dt><dd>${esc(source.provenance.retrieved)}</dd>` : ''}</dl>`;
  if (!section) return `${head}<p role="alert">This section is not in the source document now.</p>`;
  const range = excerpt === null ? null : excerptRange(section.text, excerpt);
  const text = range ? `${esc(section.text.slice(0, range.start))}<mark><span class="sr">Excerpt: </span>${esc(section.text.slice(range.start, range.end))}</mark>${esc(section.text.slice(range.end))}` : esc(section.text);
  const note = excerpt === null ? '' : range ? '<p class="hint">The marked words are the excerpt the draft quotes.</p>' : '<p class="hint" role="alert">The draft\'s excerpt is not in this section word for word.</p>';
  return `${head}<div class="section-text" tabindex="0" aria-label="The section's text">${text}</div>${note}`;
}

/** The fields of an edit form: the answer, who it is for, and when (and a draft's excerpt). */
function editFields(kb: KnowledgeBase, values: { answer: string; applies: Readonly<Record<string, readonly string[]>>; effective: { from: string; to?: string }; excerpt?: string }, prefix: string): string {
  const facts = Object.entries(kb.settings.applies)
    .map(
      ([fact, options]) =>
        `<fieldset><legend>${esc(fact)} (none ticked: every ${esc(fact)})</legend>${options
          .map((v) => `<label><input type="checkbox" name="applies.${esc(fact)}" value="${esc(v)}"${values.applies[fact]?.includes(v) ? ' checked' : ''}> ${esc(v)}</label>`)
          .join('')}</fieldset>`,
    )
    .join('');
  return `<label for="${prefix}-answer">Answer (said word for word; at most ${kb.settings.maxAnswerChars} characters, no braces)</label>
    <textarea id="${prefix}-answer" name="answer" required maxlength="${kb.settings.maxAnswerChars * 2}" aria-describedby="${prefix}-answer-hint">${esc(values.answer)}</textarea>
    <p class="hint" id="${prefix}-answer-hint">Say only what the source says. The edit is checked as a draft is before it is approved.</p>
    ${values.excerpt !== undefined ? `<label for="${prefix}-excerpt">Excerpt (the section's words that support the answer, copied exactly)</label><textarea id="${prefix}-excerpt" name="excerpt" required>${esc(values.excerpt)}</textarea>` : ''}
    ${facts}
    <div class="row">
      <div><label for="${prefix}-from">In force from</label><input id="${prefix}-from" name="from" type="date" required value="${esc(values.effective.from)}"></div>
      <div><label for="${prefix}-to">In force to (inclusive; empty: open-ended)</label><input id="${prefix}-to" name="to" type="date" value="${esc(values.effective.to ?? '')}"></div>
    </div>`;
}

const listOf = (applies: Readonly<Record<string, string | readonly string[]>> | undefined): Record<string, readonly string[]> =>
  Object.fromEntries(Object.entries(applies ?? {}).map(([k, v]) => [k, typeof v === 'string' ? [v] : v]));

const appliesText = (applies: Readonly<Record<string, readonly string[]>>): string => {
  const entries = Object.entries(applies);
  return entries.length === 0 ? 'every caller' : entries.map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ');
};

export function draftPage(ctx: PageContext, kb: KnowledgeBase | null, d: DraftOnDisk, problems: readonly string[], proposed: ProposedTopic | undefined): string {
  if (!d.draft || !kb) return page(ctx, d.id, `<h1>Draft ${esc(d.id)}</h1><section class="card" role="alert"><p>${esc(d.file)} cannot be reviewed here: ${!d.draft ? 'it does not read as a draft' : 'the knowledge base does not load'}.</p></section>`);
  const draft = d.draft;
  const topic = Object.hasOwn(kb.topics, draft.topic) ? kb.topics[draft.topic]! : undefined;
  const topicHtml = topic
    ? `${esc(topic.title)} <span class="mono muted">${esc(draft.topic)}</span>`
    : proposed
      ? `${esc(proposed.title)} <span class="mono muted">${esc(draft.topic)}</span> <span class="chip warn">proposed</span> <a href="${href(ctx, `/topic/${encodeURIComponent(draft.topic)}`)}">review the topic</a>`
      : `<span class="mono">${esc(draft.topic)}</span> <span class="chip fail">not a topic</span>`;
  const applies = listOf(draft.applies as Record<string, string | string[]> | undefined);
  const can = ctx.reviewer !== null;
  const disabled = can ? '' : ' disabled';
  const left = `<section class="card" aria-labelledby="draft-h">
  <h2 id="draft-h">The draft</h2>
  <div class="answer" aria-label="The drafted answer">${esc(draft.answer)}</div>
  <dl>
    <dt>Topic</dt><dd>${topicHtml}</dd>
    <dt>For</dt><dd>${esc(appliesText(applies))}</dd>
    <dt>In force</dt><dd>from ${esc(draft.effective.from)}${draft.effective.to ? ` to ${esc(draft.effective.to)}` : ', open-ended'}</dd>
    <dt>Version</dt><dd class="mono">${esc(draft.version)}</dd>
    <dt>Drafted</dt><dd>by ${esc(draft.drafted.by)} on ${esc(draft.drafted.on)}</dd>
    <dt>File</dt><dd class="mono">${esc(d.file)}</dd>
  </dl>
  ${problems.length > 0 ? `<div role="alert"><h3>Before it can be approved</h3><ul class="problems">${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
  <form class="action" method="post" action="/draft/${encodeURIComponent(d.id)}/approve">${tokenField(ctx)}
    <h3>Approve as it is</h3>
    <p class="hint">You have read the answer against the marked excerpt and its section, and it says only what they say.</p>
    <button class="primary" type="submit"${problems.length > 0 || !can ? ' disabled' : ''}>Approve</button>
  </form>
  <form class="action" method="post" action="/draft/${encodeURIComponent(d.id)}/edit">${tokenField(ctx)}
    <h3>Edit, then approve</h3>
    ${editFields(kb, { answer: draft.answer, applies, effective: draft.effective, excerpt: draft.drafted.excerpt ?? '' }, 'edit')}
    <button class="primary" type="submit"${disabled}>Save the edit and approve</button>
  </form>
  <form class="action" method="post" action="/draft/${encodeURIComponent(d.id)}/reject" data-confirm="Reject this draft? It moves to kb/rejected with your reason.">${tokenField(ctx)}
    <h3>Reject</h3>
    <label for="reject-reason">Why (kept with the rejected draft)</label>
    <textarea id="reject-reason" name="reason" required></textarea>
    <button class="danger" type="submit"${disabled}>Reject the draft</button>
  </form>
</section>`;
  const right = `<section class="card" aria-labelledby="source-h"><h2 id="source-h">Its source</h2>${sectionHtml(kb.sources[draft.source.document], draft.source.section, draft.drafted.excerpt ?? '')}</section>`;
  return page(ctx, `Draft ${d.id}`, `<h1>Draft <span class="mono">${esc(d.id)}</span></h1><div class="grid">${left}${right}</div>`);
}

/** A diff as HTML, with words a screen reader announces as removed or added. */
function diffHtml(before: string, after: string): string {
  return wordDiff(before, after)
    .map((p) => (p.kind === 'same' ? esc(p.text) : p.kind === 'removed' ? `<del><span class="sr">removed: </span>${esc(p.text)}</del>` : `<ins><span class="sr">added: </span>${esc(p.text)}</ins>`))
    .join('');
}

export function passagePage(ctx: PageContext, kb: KnowledgeBase, w: Withheld, approvedText: string | null): string {
  const p: KbPassage = w.passage;
  const why = WHY[w.why];
  const source = Object.hasOwn(kb.sources, p.source.document) ? kb.sources[p.source.document] : undefined;
  const now = source && Object.hasOwn(source.sections, p.source.section) ? source.sections[p.source.section]!.text : null;
  const can = ctx.reviewer !== null;
  let change = '';
  if (w.why === 'source-changed' || w.why === 'source-gone') {
    if (approvedText === null) change = '<p class="hint">The section\'s text as it was approved was not kept (it was approved before kb:approve kept it): see the source file\'s history in git.</p>';
    else if (now === null) change = `<h3>The section as it was approved</h3><div class="section-text">${esc(approvedText)}</div>`;
    else change = `<h3>What changed in the section since it was approved</h3><div class="section-text" tabindex="0" aria-label="The section's text, with what was removed and added since the approval">${diffHtml(approvedText, now)}</div>`;
  }
  const left = `<section class="card" aria-labelledby="passage-h">
  <h2 id="passage-h">The passage <span class="chip ${why.chip}">${esc(why.text)}</span></h2>
  <div class="answer" aria-label="The answer">${esc(p.answer)}</div>
  <dl>
    <dt>Topic</dt><dd>${esc(kb.topics[p.topic]?.title ?? p.topic)} <span class="mono muted">${esc(p.topic)}</span></dd>
    <dt>For</dt><dd>${esc(appliesText(p.applies))}</dd>
    <dt>In force</dt><dd>from ${esc(p.effective.from)}${p.effective.to ? ` to ${esc(p.effective.to)}` : ', open-ended'}</dd>
    <dt>Version</dt><dd class="mono">${esc(p.version)}</dd>
    ${p.approval ? `<dt>Approved</dt><dd>by ${esc(p.approval.approvedBy)} (${esc(p.approval.owner)}) on ${esc(p.approval.on)}</dd>` : ''}
    <dt>File</dt><dd class="mono">${esc(p.file)}</dd>
  </dl>
  <p>${w.why === 'unlogged' ? 'Its approval was written outside kb:approve: no line of the log of approvals records it, so no one is on record for this answer and pnpm check refuses it until a person approves it here.' : 'Callers are not given this answer until a person approves it again.'}</p>
  ${
    w.why === 'source-gone'
      ? '<p role="alert">Its source section is gone, so it cannot be approved: point the passage at the section that says this now (source.section in its file), or delete it.</p>'
      : `<form class="action" method="post" action="/passage/${encodeURIComponent(p.id)}/approve">${tokenField(ctx)}
    <h3>Approve as it is</h3>
    <p class="hint">The answer still says only what the section says now.</p>
    <button class="primary" type="submit"${can ? '' : ' disabled'}>Approve again</button>
  </form>
  <form class="action" method="post" action="/passage/${encodeURIComponent(p.id)}/edit">${tokenField(ctx)}
    <h3>Edit, then approve</h3>
    ${editFields(kb, { answer: p.answer, applies: p.applies, effective: p.effective }, 'edit')}
    <button class="primary" type="submit"${can ? '' : ' disabled'}>Save the edit and approve</button>
  </form>`
  }
</section>`;
  const right = `<section class="card" aria-labelledby="source-h"><h2 id="source-h">Its source now</h2>${change}${sectionHtml(source, p.source.section, null)}</section>`;
  return page(ctx, `Passage ${p.id}`, `<h1>Passage <span class="mono">${esc(p.id)}</span></h1><div class="grid">${left}${right}</div>`);
}

export function topicPage(ctx: PageContext, kb: KnowledgeBase, t: ProposedTopic, drafts: readonly DraftOnDisk[]): string {
  const can = ctx.reviewer !== null ? '' : ' disabled';
  const existing = Object.values(kb.topics);
  const body = `<h1>Proposed topic <span class="mono">${esc(t.id)}</span></h1>
<div class="grid">
<section class="card" aria-labelledby="topic-h">
  <h2 id="topic-h">The topic</h2>
  <dl>
    <dt>Title</dt><dd>${esc(t.title)} <span class="muted">(said to callers)</span></dd>
    <dt>Keywords</dt><dd>${t.keywords && t.keywords.length > 0 ? esc(t.keywords.join(', ')) : '<span class="muted">none</span>'}</dd>
    <dt>Callers ask</dt><dd>${t.asks && t.asks.length > 0 ? `<ul class="problems">${t.asks.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : '<span class="muted">none</span>'}</dd>
  </dl>
  <form class="action" method="post" action="/topic/${encodeURIComponent(t.id)}/accept">${tokenField(ctx)}
    <h3>Accept it into topics.yaml</h3>
    <label for="topic-title">Its title (callers hear it)</label>
    <input id="topic-title" name="title" type="text" value="${esc(t.title)}" required maxlength="80" aria-describedby="topic-title-hint">
    <p class="hint" id="topic-title-hint">A topic's title is spoken to callers: the topic question offers it ("Is it about Opening hours, or about Late fees?"). Write it as a caller would recognise it, in a few words.</p>
    <label for="topic-as">Its id (rename it here; its drafts follow)</label>
    <input id="topic-as" name="as" type="text" value="${esc(t.id)}" pattern="[A-Za-z][A-Za-z0-9_]*" required aria-describedby="topic-as-hint">
    <p class="hint" id="topic-as-hint">Letters, digits and underscores, starting with a letter.</p>
    <button class="primary" type="submit"${can}>Accept the topic</button>
  </form>
  <form class="action" method="post" action="/topic/${encodeURIComponent(t.id)}/merge">${tokenField(ctx)}
    <h3>Merge it into a topic the knowledge base has</h3>
    <label for="topic-into">Topic</label>
    <select id="topic-into" name="into" required>${existing.map((e) => `<option value="${esc(e.id)}">${esc(e.title)} (${esc(e.id)})</option>`).join('')}</select>
    <button type="submit"${can || (existing.length === 0 ? ' disabled' : '')}>Merge</button>
  </form>
</section>
<section class="card" aria-labelledby="topic-drafts-h">
  <h2 id="topic-drafts-h">Drafts that answer it (${drafts.length})</h2>
  ${drafts.length === 0 ? '<p class="muted">None waits.</p>' : `<ul>${drafts.map((d) => `<li><a class="mono" href="${href(ctx, `/draft/${encodeURIComponent(d.id)}`)}">${esc(d.id)}</a>: ${esc(d.draft?.answer ?? '')}</li>`).join('')}</ul>`}
</section>
</div>`;
  return page(ctx, `Topic ${t.id}`, body);
}

export function notFoundPage(ctx: PageContext, what: string): string {
  return page(ctx, 'Not found', `<h1>Not found</h1><section class="card"><p>${esc(what)}</p><p><a href="${href(ctx, '/')}">Everything waiting</a></p></section>`);
}
