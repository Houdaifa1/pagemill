// Real-book QA for the searchable-text (OCR) feature.
//
// Builds the Grade-3 book twice from the same source folder — once with OCR off
// and once with OCR on, with everything else identical — then proves that:
//   * page geometry, page sizes, and image placement are bit-identical
//   * every original compressed PNG stream survives in both PDFs
//   * covers are skipped and interiors carry an invisible text layer
//   * page numbering still starts at 1 on the first interior page
// and reports honest build times for both modes.
//
// The OCR engine here is the same Tesseract build and the same vendored English
// model the browser uses, so the timings and the recognized text are
// representative of the deployed app.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorker } from 'tesseract.js';
import { cpus } from 'node:os';

import { naturalCompare } from '../js/natural-sort.js';
import { parseDirectJpeg, parseDirectRgbPng } from '../js/fast-png-pdf.js';
import { buildBookPdf, getImagePlacement, shouldOcrPage } from '../js/pdf-builder.js';
import { flattenRecognizedWords } from '../js/ocr.js';

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = process.env.BINDERY_QA_BOOK;
if (!sourceDir) throw new Error('Set BINDERY_QA_BOOK to a folder of book-page images.');
const outputDir = resolve(here, '../output/pdf');
const langPath = resolve(here, '../vendor/tesseract/lang');
const squareCoverCount = 1;
const pageNumbersEnabled = true;
// Matches what the browser picks: cores/3, capped at 4.
const ocrConcurrency = Math.max(1, Math.min(4, Math.floor(cpus().length / 3)));

const names = (await readdir(sourceDir))
  .filter((name) => /\.(png|jpe?g)$/i.test(name))
  .sort(naturalCompare);
if (names.length === 0) throw new Error(`No source images found in ${sourceDir}`);

const sourceBytes = new Map();
for (const name of names) sourceBytes.set(name, await readFile(resolve(sourceDir, name)));

function makeHandles() {
  return names.map((name) => ({
    name,
    handle: {
      async getFile() {
        const bytes = sourceBytes.get(name);
        return {
          name,
          async arrayBuffer() {
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          },
        };
      },
    },
  }));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function comparePlacements(a, b) {
  assert(a.length === b.length, `page count differs: ${a.length} vs ${b.length}`);
  for (let index = 0; index < a.length; index += 1) {
    for (const key of ['pageWidth', 'pageHeight']) {
      assert(a[index][key] === b[index][key], `page ${index + 1}: ${key} changed with OCR on`);
    }
    for (const key of ['x', 'y', 'width', 'height']) {
      assert(
        a[index].placement[key] === b[index].placement[key],
        `page ${index + 1}: image ${key} changed with OCR on `
          + `(${a[index].placement[key]} vs ${b[index].placement[key]})`
      );
    }
    assert(
      a[index].pageNumber === b[index].pageNumber,
      `page ${index + 1}: page number changed with OCR on`
    );
  }
}

function assertStreamsPreserved(pdfBytes, label) {
  const buffer = Buffer.from(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength);
  let jpegs = 0;
  let pngStreams = 0;
  for (const name of names) {
    const bytes = sourceBytes.get(name);
    const parsed = bytes[0] === 0xff && bytes[1] === 0xd8
      ? parseDirectJpeg(bytes, name)
      : parseDirectRgbPng(bytes, name);
    assert(parsed.supported, `${name}: ${parsed.reason}`);
    const embedded = parsed.format === 'jpg'
      ? bytes
      : Buffer.concat(parsed.idatChunks.map((chunk) => Buffer.from(chunk)));
    assert(
      buffer.indexOf(embedded) !== -1,
      `${label}: ${name} original compressed image stream is missing from the output PDF`
    );
    if (parsed.format === 'jpg') jpegs += 1;
    else pngStreams += 1;
  }
  return { jpegs, pngStreams };
}

function assertPlacementMath(pages, label) {
  for (const page of pages) {
    const expected = getImagePlacement(page.width, page.height, false, page.pageWidth, page.pageHeight);
    for (const key of ['x', 'y', 'width', 'height']) {
      assert(
        Math.abs(page.placement[key] - expected[key]) < 1e-9,
        `${label}: page ${page.index + 1} image ${key} does not match the contained-fit placement`
      );
    }
  }
}

await mkdir(outputDir, { recursive: true });

// ---- 1. Baseline: OCR off (today's production behaviour) ----
const offPages = [];
const offStart = performance.now();
const offBytes = await buildBookPdf(makeHandles(), null, {
  title: 'Grade 3 OCR-off QA',
  squareCoverCount,
  pageNumbersEnabled,
  onPageProcessed: (page) => offPages.push(page),
});
const offSeconds = (performance.now() - offStart) / 1000;
await writeFile(resolve(outputDir, 'Grade-3-ocr-off-QA.pdf'), offBytes);
assertPlacementMath(offPages, 'OCR off');
const offPreserved = assertStreamsPreserved(offBytes, 'OCR off');
assert(
  offPages.every((page) => (page.textLayerWordCount || 0) === 0),
  'OCR off must not write any text layer'
);

// ---- 2. Searchable text: OCR on, everything else identical ----
const workerPool = [];
for (let i = 0; i < ocrConcurrency; i += 1) {
  workerPool.push(await createWorker('eng', 1, {
    langPath,
    gzip: true,
    cachePath: resolve(here, '../tmp/tesseract-cache'),
    logger: () => {},
  }));
}
const idle = [...workerPool];
const waiting = [];
const takeWorker = () => idle.pop() || new Promise((r) => waiting.push(r));
const giveWorker = (w) => { const n = waiting.shift(); if (n) n(w); else idle.push(w); };

const ocrPages = [];
const onPages = [];
// Cached so the PDF-side of this fixture can be re-run without paying for OCR
// again while iterating on the text layer.
const wordCache = {};
let recognizedWords = 0;
let ocrSeconds = 0;
const onStart = performance.now();
let onBytes;
try {
  onBytes = await buildBookPdf(makeHandles(), null, {
    title: 'Grade 3 OCR-on QA',
    squareCoverCount,
    pageNumbersEnabled,
    searchableText: true,
    ocrConcurrency,
    recognizeWords: async (file, meta) => {
      const buffer = Buffer.from(await file.arrayBuffer());
      const worker = await takeWorker();
      const started = performance.now();
      let data;
      try {
        ({ data } = await worker.recognize(buffer, {}, { text: false, blocks: true }));
      } finally {
        giveWorker(worker);
      }
      ocrSeconds += (performance.now() - started) / 1000;
      const words = flattenRecognizedWords(data);
      recognizedWords += words.length;
      ocrPages.push({ pageIndex: meta.pageIndex, name: meta.name, words: words.length });
      wordCache[meta.name] = words;
      process.stderr.write(`  OCR ${meta.completed + 1}/${meta.total} ${meta.name}: ${words.length} words\n`);
      return words;
    },
    onPageProcessed: (page) => onPages.push(page),
  });
} finally {
  await Promise.all(workerPool.map((w) => w.terminate()));
}
const onSeconds = (performance.now() - onStart) / 1000;
await writeFile(resolve(outputDir, 'Grade-3-ocr-on-QA.pdf'), onBytes);

// ---- 3. Invariants ----
assertPlacementMath(onPages, 'OCR on');
comparePlacements(offPages, onPages);
const onPreserved = assertStreamsPreserved(onBytes, 'OCR on');

assert(
  ocrPages.every((page) => shouldOcrPage(page.pageIndex, squareCoverCount)),
  'OCR ran on a cover page'
);
assert(
  ocrPages.length === names.length - squareCoverCount,
  `expected ${names.length - squareCoverCount} OCR'd interior pages, got ${ocrPages.length}`
);
for (let index = 0; index < squareCoverCount; index += 1) {
  assert(
    (onPages[index].textLayerWordCount || 0) === 0,
    `cover page ${index + 1} must have no text layer`
  );
  assert(onPages[index].pageWidth === 612 && onPages[index].pageHeight === 612,
    `cover page ${index + 1} must be a 612x612 square page`);
}
for (let index = squareCoverCount; index < names.length; index += 1) {
  assert(onPages[index].pageWidth === 612 && onPages[index].pageHeight === 792,
    `interior page ${index + 1} must be 612x792 US Letter`);
  assert(
    (onPages[index].textLayerWordCount || 0) > 0,
    `interior page ${index + 1} has no invisible text`
  );
}
assert(onPages[squareCoverCount].pageNumber === 1, 'first interior page must be numbered 1');
assert(
  onPages[names.length - 1].pageNumber === names.length - squareCoverCount,
  'last interior page number is wrong'
);

const onText = Buffer.from(onBytes.buffer, onBytes.byteOffset, onBytes.byteLength).toString('latin1');
assert(onText.includes('\n3 Tr\n'), 'OCR text must use PDF rendering mode 3 (invisible)');
assert(onText.includes('/BaseFont /Helvetica\n'.trim()) || onText.includes('/BaseFont /Helvetica '),
  'OCR text layer font is missing');

await writeFile(
  resolve(here, '../tmp/qa/grade3-ocr-words.json'),
  JSON.stringify(wordCache)
);

console.log(JSON.stringify({
  sourceDir,
  sourcePages: names.length,
  squareCoverCount,
  pageNumbersEnabled,
  ocrConcurrency,
  ocrPages: ocrPages.length,
  recognizedWords,
  firstInteriorPageNumber: onPages[squareCoverCount].pageNumber,
  lastInteriorPageNumber: onPages[names.length - 1].pageNumber,
  ocrOffSeconds: Number(offSeconds.toFixed(2)),
  ocrOnSeconds: Number(onSeconds.toFixed(2)),
  ocrOnlySeconds: Number(ocrSeconds.toFixed(2)),
  ocrOffMiB: Number((offBytes.length / 1024 / 1024).toFixed(2)),
  ocrOnMiB: Number((onBytes.length / 1024 / 1024).toFixed(2)),
  preservedOff: offPreserved,
  preservedOn: onPreserved,
}, null, 2));
