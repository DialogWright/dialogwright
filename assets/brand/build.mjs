// Builds the DialogWright logo SVGs in this folder.
// The mark is plain geometry (one stroked path, teal above y=183, navy below). The wordmark is
// "DialogWright" set in Plus Jakarta Sans ExtraBold (SIL Open Font License 1.1), tracked -2.5%,
// converted to outlines so the SVGs need no font.
// To rebuild: npm install opentype.js @fontsource/plus-jakarta-sans, then `node build.mjs`
// (it writes into ./dist; copy the results here).
import opentype from 'opentype.js';
import { readFileSync, writeFileSync } from 'node:fs';
const TEAL = '#009DA0', NAVY = '#1E2B79', WHITE = '#FFFFFF';
const MARK = 'M60 318V140A82 82 0 0 1 142 58H343A82 82 0 0 1 425 140V150Q425 186 394 208L286 296L196 236Z';
const FONT = 'node_modules/@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-800-normal.woff';
const TRACK = -0.025; // of the font size, between letters

function mark(top, bottom, id) {
  return `<defs><clipPath id="${id}t"><rect x="0" y="0" width="490" height="183"/></clipPath>` +
    `<clipPath id="${id}b"><rect x="0" y="183" width="490" height="230"/></clipPath></defs>` +
    `<g fill="none" stroke-width="80" stroke-miterlimit="3">` +
    `<path d="${MARK}" stroke="${top}" clip-path="url(#${id}t)"/><path d="${MARK}" stroke="${bottom}" clip-path="url(#${id}b)"/></g>`;
}
function word(x, baseline, capHeight) {
  const b = readFileSync(FONT);
  const font = opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const size = capHeight / (font.tables.os2.sCapHeight / font.unitsPerEm);
  const scale = size / font.unitsPerEm;
  const glyphs = [...'DialogWright'].map((c) => font.charToGlyph(c));
  let pen = x, right = x, bottom = baseline; const parts = [];
  glyphs.forEach((g, i) => {
    const p = g.getPath(pen, baseline, size); parts.push(p.toPathData(1));
    const bb = p.getBoundingBox(); right = Math.max(right, bb.x2); bottom = Math.max(bottom, bb.y2);
    const next = glyphs[i + 1];
    pen += (g.advanceWidth + (next ? font.getKerningValue(g, next) : 0)) * scale + (next ? TRACK * size : 0);
  });
  return { d: parts.join(''), right, bottom };
}
const svg = (vb, body, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;
const w = word(548, 250, 147);
const W = Math.ceil(w.right + 10) - 10, H = 391;
writeFileSync('dist/dialogwright-logo.svg', svg(`10 8 ${W} ${H}`, mark(TEAL, NAVY, 'l') + `<path d="${w.d}" fill="${NAVY}"/>`, 'DialogWright'));
writeFileSync('dist/dialogwright-logo-dark.svg', svg(`10 8 ${W} ${H}`, mark(TEAL, WHITE, 'd') + `<path d="${w.d}" fill="${WHITE}"/>`, 'DialogWright'));
writeFileSync('dist/dialogwright-mark.svg', svg('7.5 -31.5 470 470', mark(TEAL, NAVY, 'm'), 'DialogWright'));
writeFileSync('dist/dialogwright-mark-dark.svg', svg('7.5 -31.5 470 470', mark(TEAL, WHITE, 'n'), 'DialogWright'));
writeFileSync('dist/favicon.svg', svg('7.5 -31.5 470 470', mark(TEAL, NAVY, 'f'), 'DialogWright'));
console.log('logo', W, H, 'descender bottom', w.bottom.toFixed(1));
