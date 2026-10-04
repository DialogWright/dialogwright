/**
 * @dialogwright/kb-author: building a DialogWright knowledge base from documents. It reads sources (a
 * folder of PDF, DOCX, HTML, Markdown and text files, or a website crawled politely to a link depth)
 * into `kb/sources/<doc>.yaml` with each document's sections and provenance, and drafts passages from
 * them with a pluggable drafter into `kb/pending`, for a person to review.
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
export type { DocumentChange, SectionChange, SectionStatus, SourceInput } from './write';
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

export { main, ingestCommand, USER_AGENT, VERSION } from './cli';
