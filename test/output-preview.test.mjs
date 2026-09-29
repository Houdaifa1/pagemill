import assert from 'node:assert/strict';
import { selectPreviewPageIndexes, buildPreviewPdf } from '../js/preview.js';
import { resolveOutputDirectory, listPdfNames } from '../js/output-location.js';
import { choosePreviewPdfName } from '../js/output-name.js';
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
assert.equal(await buildPreviewPdf(await full.save(), [], PDFLib), null);

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
const target = await resolveOutputDirectory(book, destination);
assert.equal(target.name, 'Book');
assert.equal(destination.children.get('Library').children.get('Series').children.get('Book'), target);
target.children.set('Book.pdf', { kind: 'file' });
target.children.set('scan.png', { kind: 'file' });
target.children.set('Archive.pdf', { kind: 'file' });
assert.deepEqual(await listPdfNames(target), ['Book.pdf', 'Archive.pdf']);
assert.equal(choosePreviewPdfName('Book.pdf', ['Book.pdf']), 'Book - Preview.pdf');
assert.equal(choosePreviewPdfName('Book.pdf', ['Book - Preview.pdf']), 'Book - Preview 2.pdf');
assert.equal(choosePreviewPdfName('Book.pdf', ['Book.pdf'], 'Book.pdf'), 'Book - Preview.pdf');

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
