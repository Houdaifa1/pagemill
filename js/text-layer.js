// Turns OCR word boxes into positioned, invisible PDF text runs.
//
// This module is deliberately pure: it never touches the OCR engine, the DOM,
// or the file system, so both PDF engines and the regression suite can use it.
// Nothing here alters, re-encodes, or moves the page image — the caller passes
// in the *already decided* image placement and every word is mapped into that
// exact rectangle.

// Helvetica advance widths (1/1000 em) for WinAnsi codes 32-255, generated
// from the same standard-font metrics pdf-lib uses, so the direct engine and
// the pdf-lib compatibility path lay text out identically.
const HELVETICA_WIDTHS_32_255 = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0,
  222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 500, 278,
  333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400,
  584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667,
  667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722,
  722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556,
  556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556,
  556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

// WinAnsiEncoding's 0x80-0x9F block. 0x20-0x7E and 0xA0-0xFF are identical to
// Unicode, so only this window needs an explicit table.
const WIN_ANSI_HIGH_BLOCK = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

// Characters Tesseract emits that WinAnsi cannot represent. Substituting a
// visually equivalent character keeps the copied text readable instead of
// silently deleting part of a worksheet sentence. Accented Latin letters
// (á, é, í, ó, ú, ñ, ü, ç ...) are *not* in this table because WinAnsi already
// encodes them exactly — see README "Searchable text (OCR)".
const NON_WIN_ANSI_SUBSTITUTES = {
  0x2032: "'", 0x2033: '"', 0x2010: '-', 0x2011: '-', 0x2012: '-',
  0x2015: '-', 0x2212: '-', 0x00a0: ' ', 0x2007: ' ', 0x2009: ' ',
  0x200a: ' ', 0x202f: ' ', 0x2044: '/', 0x2028: ' ', 0x2029: ' ',
  0x0141: 'L', 0x0142: 'l', 0x0131: 'i', 0x2264: '<=', 0x2265: '>=',
};

export const TEXT_LAYER_FONT = 'Helvetica';
export const MIN_TEXT_LAYER_FONT_SIZE = 0.5;
export const MAX_TEXT_LAYER_FONT_SIZE = 400;
export const MIN_HORIZONTAL_SCALE = 5;
const WORD_SEPARATOR_CODE = 0x20;
export const MAX_HORIZONTAL_SCALE = 1000;

export function winAnsiWidth(code) {
  if (code < 32 || code > 255) return 0;
  return HELVETICA_WIDTHS_32_255[code - 32] || 0;
}

/**
 * Converts a Unicode string into WinAnsi byte codes.
 * Returns both the codes and the text they actually represent, so callers can
 * keep the two engines byte-identical and tests can prove nothing is corrupted.
 */
export function toWinAnsiCodes(text) {
  const codes = [];
  const chars = [];
  for (const char of String(text)) {
    const point = char.codePointAt(0);
    let mapped = null;
    if (point >= 0x20 && point <= 0x7e) mapped = point;
    else if (point >= 0xa0 && point <= 0xff) mapped = point;
    else if (WIN_ANSI_HIGH_BLOCK[point] !== undefined) mapped = WIN_ANSI_HIGH_BLOCK[point];

    if (mapped !== null) {
      codes.push(mapped);
      chars.push(char);
      continue;
    }
    const substitute = NON_WIN_ANSI_SUBSTITUTES[point];
    if (substitute === undefined) continue; // unrepresentable: drop, never corrupt
    for (const replacement of substitute) {
      codes.push(replacement.codePointAt(0));
      chars.push(replacement);
    }
  }
  return { codes, text: chars.join('') };
}

/** Natural (unscaled) advance width of WinAnsi codes at the given font size. */
export function textWidthAtSize(codes, fontSize) {
  let units = 0;
  for (const code of codes) units += winAnsiWidth(code);
  return (units / 1000) * fontSize;
}

/** Serializes WinAnsi codes as a PDF literal string, escaping as required. */
export function codesToPdfLiteral(codes) {
  let out = '(';
  for (const code of codes) {
    if (code === 0x28) out += '\\(';
    else if (code === 0x29) out += '\\)';
    else if (code === 0x5c) out += '\\\\';
    else if (code >= 32 && code <= 126) out += String.fromCharCode(code);
    else out += `\\${code.toString(8).padStart(3, '0')}`;
  }
  return `${out})`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, places = 4) {
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Maps OCR word boxes (image pixels, top-left origin) into PDF text runs
 * (points, bottom-left origin) inside the *existing* image placement.
 *
 *   pdfX = placement.x + (ocrX / imagePixelWidth) * placement.width
 *   pdfY = placement.y + placement.height
 *          - (ocrBottomY / imagePixelHeight) * placement.height
 *
 * Words are emitted in the order given, so callers must pass them in reading
 * order (top-to-bottom, left-to-right).
 */
export function layoutOcrWords(words, { imageWidth, imageHeight, placement, minConfidence = 0 }) {
  if (!Array.isArray(words) || !imageWidth || !imageHeight || !placement) return [];
  const scaleX = placement.width / imageWidth;
  const scaleY = placement.height / imageHeight;
  const items = [];

  for (const word of words) {
    if (!word || !word.bbox) continue;
    if (typeof word.confidence === 'number' && word.confidence < minConfidence) continue;

    const { codes, text } = toWinAnsiCodes(word.text ?? '');
    if (codes.length === 0) continue;

    const { x0, y0, x1, y1 } = word.bbox;
    const boxWidth = (x1 - x0) * scaleX;
    const boxHeight = (y1 - y0) * scaleY;
    if (!(boxWidth > 0) || !(boxHeight > 0)) continue;

    const fontSize = clamp(boxHeight, MIN_TEXT_LAYER_FONT_SIZE, MAX_TEXT_LAYER_FONT_SIZE);
    // Horizontal scaling is derived from the word alone, so the glyphs line up
    // with the printed word rather than being squeezed to make room for the
    // separator below.
    const naturalWidth = textWidthAtSize(codes, fontSize);
    const horizontalScale = naturalWidth > 0
      ? clamp((boxWidth / naturalWidth) * 100, MIN_HORIZONTAL_SCALE, MAX_HORIZONTAL_SCALE)
      : 100;

    // Each run ends with an explicit space. Position-aware extractors (Poppler,
    // Preview, Acrobat, pdf.js) already infer word gaps from the coordinates,
    // but simpler ones concatenate adjacent runs and would otherwise produce
    // "practicesentence". The space is invisible like the rest of the layer and
    // costs a few kilobytes across a whole book.
    items.push({
      text: `${text} `,
      codes: [...codes, WORD_SEPARATOR_CODE],
      x: roundTo(placement.x + x0 * scaleX),
      y: roundTo(placement.y + placement.height - y1 * scaleY),
      size: roundTo(fontSize, 3),
      horizontalScale: roundTo(horizontalScale, 2),
      width: roundTo(boxWidth),
      height: roundTo(boxHeight),
    });
  }

  return items;
}

/**
 * Content-stream operators for one page's invisible text layer.
 * Text rendering mode 3 makes the glyphs non-painting: the page image below is
 * untouched and still the only thing a reader sees. The whole run is wrapped in
 * q/Q so the text state (including Tr) can never leak into later content such
 * as the visible page-number badge.
 */
export function textLayerOperators(items, fontResourceName = 'F1') {
  if (!items || items.length === 0) return [];
  const ops = ['q', 'BT', '3 Tr'];
  let lastSize = null;
  let lastScale = null;
  for (const item of items) {
    if (item.size !== lastSize) {
      ops.push(`/${fontResourceName} ${item.size} Tf`);
      lastSize = item.size;
    }
    if (item.horizontalScale !== lastScale) {
      ops.push(`${item.horizontalScale} Tz`);
      lastScale = item.horizontalScale;
    }
    ops.push(`1 0 0 1 ${item.x} ${item.y} Tm`);
    ops.push(`${codesToPdfLiteral(item.codes)} Tj`);
  }
  ops.push('ET', 'Q');
  return ops;
}
