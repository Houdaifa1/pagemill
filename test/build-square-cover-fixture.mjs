import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { buildDirectRgbPngPdf, parseDirectRgbPng } from '../js/fast-png-pdf.js';
import { getImagePlacement, getPageLayout, LETTER_HEIGHT, LETTER_WIDTH } from '../js/pdf-builder.js';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../output/pdf/square-cover-regression.pdf');

const fixtures = [
  {
    name: 'cover-square.png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOI1t0SrbuFAUIBACE6BPHDfGk/AAAAAElFTkSuQmCC',
  },
  {
    name: 'page-001.png',
    base64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAADklEQVR4nGP4CgYMKBQAtPYROyIMe7QAAAAASUVORK5CYII=',
  },
];

const images = fixtures.map(({ name, base64 }) => {
  const parsed = parseDirectRgbPng(Uint8Array.from(Buffer.from(base64, 'base64')), name);
  if (!parsed.supported) throw new Error(parsed.reason);
  return { ...parsed, name };
});

const pdfBytes = buildDirectRgbPngPdf(images, {
  pageWidth: LETTER_WIDTH,
  pageHeight: LETTER_HEIGHT,
  pageSizeForPage: (image, index) => {
    const layout = getPageLayout(image.name, image.width, image.height, index);
    return { width: layout.pageWidth, height: layout.pageHeight, kind: layout.kind };
  },
  placementForPage: (width, height, index, pageSize) => {
    const layout = getPageLayout(images[index].name, width, height, index);
    return getImagePlacement(width, height, layout.fillPage, pageSize.width, pageSize.height);
  },
  title: 'Bindery square-cover regression',
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, pdfBytes);
console.log(outputPath);
