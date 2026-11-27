import type { LiteParseConfig, LiteParseOpen, LpPage, LpTextItem } from '../extract/liteparse';

/** Fakes of LiteParse's parse for the tests (../extract/liteparse.ts): pages built from text items and table blocks. */

/** A text item as LiteParse gives one: its box from the page's top, its font, its size and its words. */
export function item(text: string, x: number, top: number, size = 10, options: { bold?: boolean; words?: LpTextItem['words']; confidence?: number } = {}): LpTextItem {
  const width = text.length * size * 0.5;
  return {
    text,
    x,
    y: top,
    width,
    height: size * 1.2,
    fontName: options.bold ? 'Helvetica-Bold' : 'Helvetica',
    fontSize: size,
    fontHeight: size,
    fontAscent: size * 0.95,
    fontDescent: -size * 0.25,
    fontWeight: options.bold ? 700 : 400,
    ...(options.words ? { words: options.words } : {}),
    ...(options.confidence !== undefined ? { confidence: options.confidence } : {}),
  };
}

export const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/** A fake of LiteParse: the pages it gives for each parse, by whether OCR is on, and the configs it was opened with. */
export function fakeLiteParse(pages: (config: LiteParseConfig) => LpPage[], total?: number): { open: LiteParseOpen; configs: LiteParseConfig[] } {
  const configs: LiteParseConfig[] = [];
  const open: LiteParseOpen = (config) => {
    configs.push(config);
    return { parse: async () => { const ps = pages(config); return { totalPages: total ?? ps.length, pages: ps }; } };
  };
  return { open, configs };
}

/** A page of a table: a heading, a sentence, then a heading row and two rows of figures, with LiteParse's table block over them. */
export function tablePage(rows: { label: string; top: number; values: string[] }[], block?: LpPage['blocks']): LpPage & { textItems: LpTextItem[] } {
  const items: LpTextItem[] = [item('Visit costs', 72, 60, 14, { bold: true }), item('What a visit costs, by where it is.', 72, 82)];
  items.push(item('Service', 72, 110, 10, { bold: true }), item('In network', 250, 110, 10, { bold: true }), item('Out of network', 400, 110, 10, { bold: true }));
  for (const r of rows) {
    items.push(item(r.label, 72, r.top));
    r.values.forEach((v, k) => items.push(item(v, 250 + k * 150, r.top)));
  }
  items.push(item('Hours', 72, 300, 14, { bold: true }), item('Open daily.', 72, 322));
  const cell = (text: string, x: number, top: number) => ({ text, bbox: box(x, top, 100, 12), textItemIndices: [] });
  return {
    pageNum: 1,
    width: 612,
    height: 792,
    textItems: items,
    blocks: block ?? [
      {
        kind: 'table',
        header: [cell('Service', 72, 110), cell('In network', 250, 110), cell('Out of network', 400, 110)],
        rows: rows.map((r) => [cell(r.label, 72, r.top), ...r.values.map((v, k) => cell(v, 250 + k * 150, r.top))]),
        textItemIndices: [],
      },
    ],
  };
}


/** A table LiteParse read with two rows run into one (as it did with two stations of a timetable), where our readers keep them apart. */
export function mergedRowsPage(): LpPage {
  const cell = (text: string, x: number, top: number, height = 12) => ({ text, bbox: box(x, top, 100, height), textItemIndices: [] });
  return tablePage(
    [
      { label: 'Office visit', top: 130, values: ['$20', '$60'] },
      { label: 'Urgent care', top: 144, values: ['$50', '$75'] },
    ],
    [
      {
        kind: 'table',
        header: [cell('Service', 72, 110), cell('In network', 250, 110), cell('Out of network', 400, 110)],
        rows: [[cell('Office visit Urgent care', 72, 130, 26), cell('$20 $50', 250, 130, 26), cell('$60 $75', 400, 130, 26)]],
        textItemIndices: [],
      },
    ],
  );
}

/** Two pages, the second a scan (no text layer, one image over the page, LiteParse's complexity says `scanned`): what LiteParse gives with OCR off, and with OCR on for page 2 (its items with a confidence). */
export function scannedPages(config: LiteParseConfig): LpPage[] {
  const first: LpPage = { pageNum: 1, width: 612, height: 792, textItems: [item('Opening hours', 72, 60, 14), item('The branch opens at nine.', 72, 82)] };
  if (!config.ocrEnabled) return [first, { pageNum: 2, width: 612, height: 792, textItems: [], complexity: { reasons: ['scanned'], fullPageImage: true } }];
  return [{ pageNum: 2, width: 612, height: 792, textItems: [item('Late fees', 72, 60, 14, { confidence: 0.9 }), item('Each day late is 25 cents.', 72, 82, 10, { confidence: 0.92 })] }];
}
