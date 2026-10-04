/**
 * @dialogwright/kb-author: building a DialogWright knowledge base from documents. This half reads
 * sources: a folder of PDF, DOCX, HTML, Markdown and text files, or a website crawled politely to a
 * link depth, into `kb/sources/<doc>.yaml` with each document's sections and provenance.
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
export { main, ingestCommand, USER_AGENT, VERSION } from './cli';
