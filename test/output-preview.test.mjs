import assert from 'node:assert/strict';
import { selectPreviewPageIndexes, buildPreviewPdf } from '../js/preview.js';
import {
  OUTPUT_LAYOUT_FLAT,
  OUTPUT_LAYOUT_FOLDERS,
  resolveOutputDirectory,
  listPdfNames,
  createOutputNameAllocator,
} from '../js/output-location.js';
import { choosePreviewPdfName, chooseFlatOutputPdfName } from '../js/output-name.js';
import { prepareBookPages } from '../js/book-pages.js';
import { buildBookPdf } from '../js/pdf-builder.js';
import { scanBooks } from '../js/fs-scan.js';
import { loadPdfLib } from './load-pdf-lib.mjs';

for (const [total, expected] of [[30, 3], [50, 5], [100, 10]]) {
  const pages = selectPreviewPageIndexes(total, 3);
  assert.equal(pages.length, expected);
  assert.ok(pages.every((index) => index >= 3 && index < total));
  assert.equal(new Set(pages).size, pages.length);
  assert.deepEqual(pages, [...pages].sort((a, b) => a - b));
}
assert.equal(selectPreviewPageIndexes(50, 3, 7).length, 7);
assert.deepEqual(selectPreviewPageIndexes(5, 3, 10), [3, 4]);
assert.deepEqual(selectPreviewPageIndexes(3, 3), []);
assert.deepEqual(selectPreviewPageIndexes(10, 3, null, () => 0), [3, 4, 5]);

const PDFLib = loadPdfLib();
const full = await PDFLib.PDFDocument.create();
for (let index = 0; index < 8; index += 1) full.addPage([200 + index, 300 + index]);
const previewBytes = await buildPreviewPdf(await full.save(), [3, 5, 7], PDFLib);
const preview = await PDFLib.PDFDocument.load(previewBytes);
assert.equal(preview.getPageCount(), 3);
assert.deepEqual(preview.getPages().map((page) => page.getWidth()), [203, 205, 207]);
for (const page of preview.getPages()) {
  const streams = page.node.Contents().asArray().map((ref) => preview.context.lookup(ref));
  const content = streams.map((stream) =>
    new TextDecoder().decode(PDFLib.decodePDFRawStream(stream).decode())
  ).join('\n');
  assert.equal((content.match(/<50524556494557> Tj/g) || []).length, 3);
}
assert.equal(await buildPreviewPdf(await full.save(), [], PDFLib), null);

const orderedNames = [
  'page-01.png', 'page-02.png', 'page-03.png', 'page-04.png', 'page-05.png',
  'cover.png', 'thumb-1.png', 'thumb-2.png',
].map((name) => ({ name }));
const unchanged = prepareBookPages(orderedNames, { coversAtEnd: true, squareCoverCount: 3 });
assert.equal(unchanged.images.length, 8);
assert.equal(unchanged.coverCount, 3);
const skipped = prepareBookPages(orderedNames, {
  coversAtEnd: true, squareCoverCount: 3, excludeFirstPages: true, excludedPageCount: 4,
});
assert.deepEqual(skipped.images.map((image) => image.name),
  ['page-05.png', 'cover.png', 'thumb-1.png', 'thumb-2.png']);
assert.equal(skipped.coverCount, 0);
assert.deepEqual(selectPreviewPageIndexes(skipped.images.length, skipped.coverCount, 3, () => 0), [0, 1, 2]);
assert.equal(prepareBookPages(orderedNames, {
  coversAtEnd: true, squareCoverCount: 3, excludeFirstPages: true, excludedPageCount: 2,
}).coverCount, 0);
const templateBook = [
  'template-1.png', 'template-2.png', 'template-3.png', 'template-4.png',
  'page-1.png', 'page-2.png',
].map((name) => ({ name }));
assert.deepEqual(prepareBookPages(templateBook, {
  coversAtEnd: true, squareCoverCount: 3, excludeFirstPages: true, excludedPageCount: 4,
}).images.map((image) => image.name), ['page-1.png', 'page-2.png']);
assert.throws(() => prepareBookPages(orderedNames, {
  coversAtEnd: true, squareCoverCount: 3, excludeFirstPages: true, excludedPageCount: 8,
}), /No pages remain/);

const rgbPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAADklEQVR4nGP4CgYMKBQAtPYROyIMe7QAAAAASUVORK5CYII=', 'base64');
const imageHandles = orderedNames.map(({ name }) => ({
  name,
  handle: { async getFile() {
    return { name, async arrayBuffer() {
      return rgbPng.buffer.slice(rgbPng.byteOffset, rgbPng.byteOffset + rgbPng.byteLength);
    } };
  } },
}));
const prepared = prepareBookPages(imageHandles, {
  coversAtEnd: true, squareCoverCount: 3, excludeFirstPages: true, excludedPageCount: 4,
});
const built = await PDFLib.PDFDocument.load(await buildBookPdf(prepared.images, PDFLib, {
  squareCoverCount: prepared.coverCount, pageNumbersEnabled: true,
}));
assert.equal(built.getPageCount(), 4);
assert.deepEqual(built.getPage(0).getSize(), { width: 612, height: 792 });

function directory(name, files = []) {
  const children = new Map(files.map((file) => [file, { kind: 'file' }]));
  return {
    kind: 'directory',
    name,
    children,
    async getDirectoryHandle(childName, { create } = {}) {
      if (!children.has(childName) && create) children.set(childName, directory(childName));
      return children.get(childName);
    },
    async *entries() { yield* children.entries(); },
  };
}

const source = directory('Book');
const destination = directory('Finished');
const book = { dirHandle: source, outputPathParts: ['Library', 'Series', 'Book'] };
assert.equal(await resolveOutputDirectory(book, null), source);
assert.equal(await resolveOutputDirectory(book, destination, OUTPUT_LAYOUT_FLAT), destination);
const target = await resolveOutputDirectory(book, destination, OUTPUT_LAYOUT_FOLDERS);
assert.equal(target.name, 'Book');
assert.equal(destination.children.get('Library').children.get('Series').children.get('Book'), target);
target.children.set('Book.pdf', { kind: 'file' });
target.children.set('scan.png', { kind: 'file' });
target.children.set('Archive.pdf', { kind: 'file' });
assert.deepEqual(await listPdfNames(target), ['Book.pdf', 'Archive.pdf']);
assert.equal(choosePreviewPdfName('Book.pdf', ['Book.pdf']), 'Book - Preview.pdf');
assert.equal(choosePreviewPdfName('Book.pdf', ['Book - Preview.pdf']), 'Book - Preview 2.pdf');
assert.equal(choosePreviewPdfName('Book.pdf', ['Book.pdf'], 'Book.pdf'), 'Book - Preview.pdf');
assert.equal(chooseFlatOutputPdfName('Book', ['Other.pdf']), 'Book.pdf');
assert.equal(chooseFlatOutputPdfName('Book', ['Book.pdf']), 'Book - 2.pdf');

const flat = directory('Flat');
const allocate = createOutputNameAllocator();
const [first, second] = await Promise.all([
  allocate({ book: { name: 'Test' }, directory: flat, key: 'flat', layout: OUTPUT_LAYOUT_FLAT, previewEnabled: true }),
  allocate({ book: { name: 'Test' }, directory: flat, key: 'flat', layout: OUTPUT_LAYOUT_FLAT, previewEnabled: true }),
]);
assert.deepEqual(first, { pdfName: 'Test.pdf', previewName: 'Test - Preview.pdf' });
assert.deepEqual(second, { pdfName: 'Test - 2.pdf', previewName: 'Test - 2 - Preview.pdf' });
const occupied = directory('Occupied', ['Test.pdf', 'Test - Preview.pdf']);
const safe = await createOutputNameAllocator()({
  book: { name: 'Test' }, directory: occupied, key: 'flat', layout: OUTPUT_LAYOUT_FLAT, previewEnabled: true,
});
assert.deepEqual(safe, { pdfName: 'Test - 2.pdf', previewName: 'Test - 2 - Preview.pdf' });
const rerun = await createOutputNameAllocator()({
  book: { name: 'Test' }, directory: occupied, key: 'flat', layout: OUTPUT_LAYOUT_FLAT,
  ownedOutput: { pdfName: 'Test.pdf', previewName: 'Test - Preview.pdf' }, previewEnabled: true,
});
assert.deepEqual(rerun, { pdfName: 'Test.pdf', previewName: 'Test - Preview.pdf' });

const library = directory('Library');
const series = directory('Series');
const nestedBook = directory('Book');
library.children.set('Series', series);
series.children.set('Book', nestedBook);
nestedBook.children.set('001.png', { kind: 'file' });
nestedBook.children.set('Book.pdf', { kind: 'file' });
nestedBook.children.set('.done', {
  kind: 'file',
  async getFile() {
    return { async text() { return JSON.stringify({ formatVersion: 5, pdfFile: 'Book.pdf' }); } };
  },
});
const [scanned] = await scanBooks(library);
assert.deepEqual(scanned.outputPathParts, ['Library', 'Series', 'Book']);
assert.equal(scanned.status, 'pending', 'old markers must rebuild even if a PDF exists');

console.log('Output and preview QA passed: destination structure, protected names, interior-only samples, and PDF page copies.');
