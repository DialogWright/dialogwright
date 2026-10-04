/**
 * @dialogwright/kb-author: building a DialogWright knowledge base from documents. It reads sources (a
 * folder of PDF, DOCX, HTML, Markdown and text files, or a website crawled politely to a link depth)
 * into `kb/sources/<doc>.yaml` with each document's sections and provenance; drafts passages from
 * them with a pluggable drafter into `kb/pending`; serves a local review page where a person approves,
 * edits or rejects each draft; refreshes the sources, withholding a passage whose source changed; and
 * ranks the gaps the traces of real calls show: what callers asked that the knowledge base did not answer.
 */

export { ingest, formatReport, IngestError, isUrl, MAX_FILE_BYTES } from './ingest';
export type { IngestOptions, IngestReport } from './ingest';
export { crawl, CrawlError, DEFAULT_MAX_PAGES, DEFAULT_RATE_MS } from './crawl/crawl';
export type { CrawlOptions, CrawlResult, CrawledDocument, CrawlRequest, CrawlSkip } from './crawl/crawl';
export { parseRobots, ROBOTS_AGENTS } from './crawl/robots';
export type { Robots } from './crawl/robots';
export { canonicalUrl, globToRegExp } from './crawl/url';
export { extract, formatOfName, EXTENSIONS } from './extract/index';
export type { Format } from './extract/index';
export { extractHtml } from './extract/html';
export { extractMarkdown, extractText } from './extract/markdown';
export { extractPdf } from './extract/pdf';
export { extractDocx } from './extract/docx';
export { sectionsOf, slugOf } from './sections';
export type { Block, ExtractedDocument, ExtractedSection } from './sections';
export { planSources, writeSources, sourceYaml, MAX_SOURCE_BYTES } from './write';
export type { CrawlProvenance, DocumentChange, SectionChange, SectionStatus, SourceInput } from './write';
export { DraftError } from './draft/drafter';
export type { Draft, DraftRequest, Drafter, ProposedTopic, TopicSummary } from './draft/drafter';
export { ClaudeDrafter, DEFAULT_DRAFT_MODEL } from './draft/claude';
export type { ClaudeDrafterOptions } from './draft/claude';
export { FakeDrafter } from './draft/fake';
export type { FakeRule } from './draft/fake';
export { draftProblems } from './draft/validate';
export type { DraftContext } from './draft/validate';
export { draftKb, formatDraftReport, DraftCommandError } from './draft/draft';
export type { DraftOptions, DraftReport } from './draft/draft';
export { acceptTopic, approve, editAndApprove, mergeTopic, reject, reviewState } from './review/actions';
export type { ActionResult, Edits, Reviewer, ReviewState } from './review/actions';
export { startReviewServer } from './review/server';
export type { ReviewServer, ReviewServerOptions } from './review/server';
export { refreshKb, formatRefreshReport } from './refresh/refresh';
export type { RefreshOptions, RefreshReport } from './refresh/refresh';
export { collectGaps, looksLikeQuestion, topicQuestionOf, GAP_KINDS, QUESTION_WORDS } from './gaps/collect';
export type { CollectContext, CollectStats, Gap, GapKind, Near, Unavailable } from './gaps/collect';
export { buildReport, reportFromFiles, formatJson, formatMarkdown, NO_NEAR_TOPIC } from './gaps/report';
export type { BuildOptions, DraftFrom, Fix, FixId, GapGroup, GapReport, Sample } from './gaps/report';
export { defaultTraceSpecs, readTurns, traceFilesOf } from './gaps/traces';
export type { Turn } from './gaps/traces';
export { gapsCommand } from './gaps/command';
export { main, ingestCommand, USER_AGENT, VERSION } from './cli';
