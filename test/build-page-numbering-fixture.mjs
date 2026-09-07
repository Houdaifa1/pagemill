import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { naturalCompare } from '../js/natural-sort.js';
import { parseDirectJpeg, parseDirectRgbPng } from '../js/fast-png-pdf.js';
import { buildBookPdf, getImagePlacement } from '../js/pdf-builder.js';

const here = dirname(fileURLToPath(import.meta.url));
const sourceDir = process.env.BINDERY_QA_BOOK;
if (!sourceDir) throw new Error('Set BINDERY_QA_BOOK to a folder of book-page images.');
const outputPath = resolve(here, '../output/pdf/Grade-3-numbered-QA.pdf');
const squareCoverCount = 1;
const names = (await readdir(sourceDir))
  .filter((name) => /\.(png|jpe?g)$/i.test(name))
  .sort(naturalCompare);

if (names.length === 0) throw new Error(`No source images found in ${sourceDir}`);

const imageHandles = names.map((name) => ({
  name,
  handle: {
    async getFile() {
      const bytes = await readFile(resolve(sourceDir, name));
      return {
        async arrayBuffer() {
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        },
      };
    },
  },
}));

const processedPages = [];
const startedAt = performance.now();
const pdfBytes = await buildBookPdf(imageHandles, null, {
  title: 'Grade 3 numbered QA',
  squareCoverCount,
  pageNumbersEnabled: true,
  onPageProcessed: (page) => processedPages.push(page),
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, pdfBytes);

const outputBuffer = Buffer.from(pdfBytes.buffer, pdfBytes.byteOffset, pdfBytes.byteLength);
let preservedJpegs = 0;
let preservedPngStreams = 0;
for (const name of names) {
  const sourceBytes = await readFile(resolve(sourceDir, name));
  const parsed = sourceBytes[0] === 0xff && sourceBytes[1] === 0xd8
    ? parseDirectJpeg(sourceBytes, name)
    : parseDirectRgbPng(sourceBytes, name);
  if (!parsed.supported) throw new Error(parsed.reason);
  const embeddedBytes = parsed.format === 'jpg'
    ? sourceBytes
    : Buffer.concat(parsed.idatChunks.map((chunk) => Buffer.from(chunk)));
  if (outputBuffer.indexOf(embeddedBytes) === -1) {
    throw new Error(`${name}: original compressed image stream not found in output PDF`);
  }
  if (parsed.format === 'jpg') preservedJpegs += 1;
  else preservedPngStreams += 1;
}

const numberedPages = processedPages.filter((page) => page.pageNumber !== null);
if (numberedPages.length !== Math.max(0, names.length - squareCoverCount)) {
  throw new Error(`Expected ${names.length - squareCoverCount} numbered pages, got ${numberedPages.length}`);
}
for (const page of processedPages) {
  const expected = getImagePlacement(
    page.width,
    page.height,
    false,
    page.pageWidth,
    page.pageHeight
  );
  for (const key of ['x', 'y', 'width', 'height']) {
    if (Math.abs(page.placement[key] - expected[key]) > 0.0001) {
      throw new Error(`Page ${page.index + 1}: numbering changed image ${key}`);
    }
  }
}

console.log(JSON.stringify({
  outputPath,
  sourcePages: names.length,
  squareCoverCount,
  numberedPages: numberedPages.length,
  firstNumber: numberedPages[0]?.pageNumber ?? null,
  lastNumber: numberedPages.at(-1)?.pageNumber ?? null,
  buildSeconds: Number(((performance.now() - startedAt) / 1000).toFixed(3)),
  outputMiB: Number((pdfBytes.length / 1024 / 1024).toFixed(2)),
  preservedJpegs,
  preservedPngStreams,
}));
