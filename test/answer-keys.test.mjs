import assert from 'node:assert/strict';
import {
  answerKeySignature,
  appendAnswerKeys,
  isBinderyOutputName,
  ownedPdfNames,
  scanAnswerKeys,
} from '../js/answer-keys.js';
import { scanBooks } from '../js/fs-scan.js';
import { buildBookPdf } from '../js/pdf-builder.js';
import { buildPreviewPdf, selectPreviewPageIndexes } from '../js/preview.js';
import { loadPdfLib } from './load-pdf-lib.mjs';

const PDFLib = loadPdfLib();
const rgbPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAADklEQVR4nGP4CgYMKBQAtPYROyIMe7QAAAAASUVORK5CYII=', 'base64');

async function makePdf(sizes) {
  const doc = await PDFLib.PDFDocument.create();
  sizes.forEach((size) => doc.addPage(size));
  return doc.save();
}

function fileEntry(contents, lastModified = 1) {
  const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
  return {
    kind: 'file',
    async getFile() {
      const blob = new Blob([bytes]);
      return Object.assign(blob, { lastModified });
    },
  };
}

// A nested object becomes a folder; anything else is a file's contents.
function folder(name, tree) {
  const children = new Map(Object.entries(tree).map(([child, value]) => [
    child,
    value && value.kind ? value
      : (typeof value === 'object' && !(value instanceof Uint8Array) ? folder(child, value) : fileEntry(value)),
  ]));
  return {
    kind: 'directory',
    name,
    children,
    async *entries() { yield* children.entries(); },
  };
}

function directFile(contents) {
  const bytes = new Uint8Array(rgbPng);
  return { ...fileEntry(bytes), contents };
}

const foreign = await makePdf([[612, 792]]);
const binderyMade = new TextEncoder().encode('%PDF-1.7\n<< /Creator (Bindery) /Producer (Bindery direct image engine) >>\n%%EOF\n');
const done = (record) => JSON.stringify({
  formatVersion: 6, squareCoverCount: 0, coversAtEnd: false,
  pageNumbersEnabled: false, searchableTextEnabled: false, ...record,
});

const library = folder('Library', {
  // Key beside the worksheets, plus this book's own previous output.
  Beside: {
    '001.png': directFile(), 'Answer Key.pdf': foreign, 'Beside.pdf': foreign,
    'Beside - Preview.pdf': foreign, '.done': done({ pdfFile: 'Beside.pdf', previewFile: null }),
  },
  // Key tucked in a folder without images, inside the book.
  Inside: { '001.png': directFile(), answers: { deep: { 'key 2.pdf': foreign, 'key 10.pdf': foreign } } },
  // The worksheets are one level down and the key sits beside that folder.
  Wrapper: { pngs: { '001.png': directFile() }, 'wrapper key.pdf': foreign },
  // Two books share a parent, so the parent's PDF cannot be assigned safely.
  Unit: { A: { '001.png': directFile() }, B: { '001.png': directFile() }, 'shared.pdf': foreign },
  // No marker: a same-named foreign PDF is a key unless Bindery built it.
  Same: { '001.png': directFile(), 'Same.pdf': foreign },
  Old: { '001.png': directFile(), 'Old.pdf': binderyMade },
  // Sidecars, hidden files, and a marker naming a file in a custom output folder.
  Noise: {
    '001.png': directFile(), '._key.pdf': 'metadata', '.hidden.pdf': foreign,
    __MACOSX: { 'key.pdf': foreign }, 'Noise.pdf': foreign,
    '.done': done({ outputMode: 'custom', pdfFile: 'Noise.pdf', sourcePdfFile: null }),
  },
  Empty: { '001.png': directFile() },
  Finished: { 'Beside.pdf': foreign },
  'loose.pdf': foreign,
});

const books = await scanBooks(library);
const scan = await scanAnswerKeys(library, books, { outputFolderNames: ['Finished'] });
const keysFor = (relativePath) => scan.candidatesByBook
  .get(books.find((book) => book.relativePath === relativePath))
  .map((key) => key.path);

assert.deepEqual(keysFor('Beside'), ['Beside/Answer Key.pdf'], 'own output and preview are never keys');
assert.deepEqual(keysFor('Inside'), ['Inside/answers/deep/key 2.pdf', 'Inside/answers/deep/key 10.pdf'], 'natural order');
assert.deepEqual(keysFor('Wrapper / pngs'), ['Wrapper/wrapper key.pdf']);
assert.deepEqual(keysFor('Unit / A'), []);
assert.deepEqual(keysFor('Same'), ['Same/Same.pdf']);
assert.equal(books.find((book) => book.relativePath === 'Same').status, 'pending', 'a PDF without a .done record does not finish a book');
assert.deepEqual(keysFor('Old'), [], 'a marker-less PDF built by Bindery is recognized from its contents');
assert.deepEqual(keysFor('Noise'), ['Noise/Noise.pdf'], 'a custom-output marker does not claim a source file');
assert.deepEqual(keysFor('Empty'), []);
assert.deepEqual(scan.unmatched.map((key) => key.path), ['Unit/shared.pdf', 'loose.pdf']);

// A library holding one book still finds a key beside the book's folder.
const single = folder('Single', { pages: { '1.png': directFile() }, 'key.pdf': foreign });
const singleBooks = await scanBooks(single);
const singleScan = await scanAnswerKeys(single, singleBooks);
assert.deepEqual(singleScan.candidatesByBook.get(singleBooks[0]).map((key) => key.path), ['key.pdf']);

// The selected folder can be the book itself.
const rootBook = folder('Root', { '1.png': directFile(), 'key.pdf': foreign, sub: { 'more.pdf': foreign } });
const rootBooks = await scanBooks(rootBook);
const rootScan = await scanAnswerKeys(rootBook, rootBooks);
assert.deepEqual(rootScan.candidatesByBook.get(rootBooks[0]).map((key) => key.path), ['key.pdf', 'sub/more.pdf']);

assert.equal(isBinderyOutputName('Book - Preview 2.pdf', 'Book'), true);
assert.equal(isBinderyOutputName('Book - Bindery 2.pdf', 'Book'), true);
assert.equal(isBinderyOutputName('Book - 2 - Preview.pdf', 'Book'), true);
assert.equal(isBinderyOutputName('Book (1+1) - Preview.pdf', 'Book (1+1)'), true, 'regex characters in names');
assert.equal(isBinderyOutputName('Book Answers.pdf', 'Book'), false);
assert.deepEqual([...ownedPdfNames({ markerRecord: { pdfFile: 'A.PDF', ownedPdfFiles: ['B.pdf'] } })].sort(), ['a.pdf', 'b.pdf']);
assert.deepEqual([...ownedPdfNames({})], []);

assert.equal(answerKeySignature([]), '', 'no keys matches markers from before this feature');
assert.notEqual(
  answerKeySignature([{ path: 'k.pdf', size: 1, lastModified: 1 }]),
  answerKeySignature([{ path: 'k.pdf', size: 2, lastModified: 1 }]),
  'a replaced key changes the signature'
);

// A real build: pages stay in order, sizes and rotation survive, and the title holds.
const imageHandles = ['p1.png', 'p2.png', 'p3.png'].map((name) => ({ name, handle: directFile() }));
const book = await buildBookPdf(imageHandles, PDFLib, { title: 'Worksheets', squareCoverCount: 0, pageNumbersEnabled: true });
const rotatedDoc = await PDFLib.PDFDocument.create();
rotatedDoc.addPage([400, 500]).setRotation(PDFLib.degrees(90));
rotatedDoc.addPage([300, 300]).drawText('Answer');
const merged = await appendAnswerKeys(book, [
  { name: 'first.pdf', path: 'first.pdf', handle: fileEntry(await rotatedDoc.save(), 42) },
  { name: 'second.pdf', path: 'second.pdf', handle: fileEntry(foreign) },
], PDFLib);
assert.equal(merged.pagesAdded, 3);
assert.deepEqual(merged.records.map((record) => [record.name, record.pages, record.lastModified]), [
  ['first.pdf', 2, 42], ['second.pdf', 1, 1],
]);
const output = await PDFLib.PDFDocument.load(merged.bytes, { updateMetadata: false });
assert.deepEqual(output.getPages().map((page) => [page.getWidth(), page.getHeight()]), [
  [612, 792], [612, 792], [612, 792], [400, 500], [300, 300], [612, 792],
]);
assert.equal(output.getPage(3).getRotation().angle, 90);
assert.equal(output.getTitle(), 'Worksheets');

// Previews choose from the book's pages and are built before keys are added.
const indexes = selectPreviewPageIndexes(imageHandles.length, 0);
assert.ok(indexes.every((index) => index < imageHandles.length));
const preview = await PDFLib.PDFDocument.load(await buildPreviewPdf(book, indexes, PDFLib));
assert.equal(preview.getPageCount(), imageHandles.length);

// Every unusable key fails with its own name and a reason the user can act on.
const plainDoc = await PDFLib.PDFDocument.create();
plainDoc.addPage();
const encrypted = new Uint8Array(Buffer.from(
  Buffer.from(await plainDoc.save({ useObjectStreams: false })).toString('latin1')
    .replace(/trailer\s*<</, 'trailer\n<< /Encrypt 1 0 R'),
  'latin1'
));
const cases = [
  ['empty.pdf', new Uint8Array(), /empty\.pdf.*not a valid PDF/],
  ['text.pdf', 'just some text', /text\.pdf.*not a valid PDF/],
  ['locked.pdf', encrypted, /locked\.pdf.*password-protected/],
];
for (const [name, contents, pattern] of cases) {
  await assert.rejects(
    appendAnswerKeys(book, [{ name, path: name, handle: fileEntry(contents) }], PDFLib),
    pattern
  );
}
await assert.rejects(appendAnswerKeys(book, [{
  name: 'gone.pdf',
  path: 'gone.pdf',
  handle: { async getFile() { throw new DOMException('gone', 'NotFoundError'); } },
}], PDFLib), /gone\.pdf.*Rescan/);

console.log('Answer key QA passed: discovery rules, own-output protection, page order, previews, and bad files.');
