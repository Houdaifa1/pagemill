import assert from 'node:assert/strict';
import { mergePdfFiles } from '../js/pdf-merge.js';
import { savePdfFolder, scanPdfFolders } from '../js/pdf-merge-folders.js';
import { loadPdfLib } from './load-pdf-lib.mjs';

const PDFLib = loadPdfLib();
const { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, degrees } = PDFLib;
const key = PDFName.of;

async function editablePdf({ width, height, text, fontName, secondPage = false }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([width, height]);
  const font = await pdf.embedFont(fontName);
  page.drawText(text, { x: 40, y: 280, size: 20, font });
  const layer = pdf.context.register(pdf.context.obj({ Type: 'OCG', Name: PDFString.of(text) }));
  pdf.catalog.set(key('OCProperties'), pdf.context.obj({ OCGs: [layer], D: { BaseState: secondPage ? 'OFF' : 'ON' } }));
  const form = pdf.getForm();
  const answer = form.createTextField('student.Name');
  answer.setText(text);
  answer.enableRequired();
  answer.addToPage(page, { x: 40, y: 200, width: 160, height: 25, font });
  const done = form.createCheckBox('Done');
  done.addToPage(page, { x: 40, y: 150, width: 20, height: 20 });
  if (!secondPage) done.check();
  const choice = form.createDropdown('Choice');
  choice.addOptions(['A', 'B']);
  choice.select(secondPage ? 'B' : 'A');
  choice.addToPage(page, { x: 40, y: 90, width: 95, height: 25, font });

  if (secondPage) {
    const other = pdf.addPage([450, 390]);
    other.setRotation(degrees(90));
    other.setCropBox(18, 24, 408, 340);
    other.setTrimBox(20, 26, 404, 336);
    answer.addToPage(other, { x: 40, y: 120, width: 160, height: 25, font });

    const dest = pdf.context.obj([other.ref, key('Fit')]);
    const destNode = pdf.context.obj({ Names: [PDFString.of('worksheet'), dest] });
    pdf.catalog.set(key('Names'), pdf.context.obj({ Dests: destNode }));
    const link = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [40, 90, 82, 120],
      A: { S: 'GoTo', D: PDFString.of('worksheet') },
    });
    page.node.addAnnot(pdf.context.register(link));
  }

  // Both inputs use the same resource alias for a different font. The tree
  // inherits its default appearance from the source document's AcroForm.
  form.updateFieldAppearances(font);
  const acroForm = pdf.catalog.lookup(key('AcroForm'), PDFDict);
  acroForm.set(key('DA'), PDFString.of('/Shared 12 Tf 0 g'));
  acroForm.set(key('DR'), pdf.context.obj({ Font: { Shared: font.ref } }));
  answer.acroField.dict.delete(key('DA'));
  for (const widget of answer.acroField.getWidgets()) widget.dict.delete(key('DA'));
  return pdf;
}

const cover = await editablePdf({ width: 710, height: 380, text: 'Cover Name', fontName: 'Courier' });
const worksheet = await editablePdf({ width: 612, height: 792, text: 'Worksheet Name', fontName: 'Times-Roman', secondPage: true });
const sourceBytes = await Promise.all([cover, worksheet].map((pdf) => pdf.save({ updateFieldAppearances: false })));
const files = sourceBytes.map((bytes, index) => new File([bytes], index ? 'Worksheets.pdf' : 'Cover.pdf'));
const merged = await PDFDocument.load(await mergePdfFiles(files, PDFLib));
assert.deepEqual(merged.getPages().map((page) => page.getSize()), [
  { width: 710, height: 380 }, { width: 612, height: 792 }, { width: 450, height: 390 },
]);
const last = merged.getPage(2);
assert.equal(last.getRotation().angle, 90);
assert.deepEqual(last.getCropBox(), { x: 18, y: 24, width: 408, height: 340 });
assert.deepEqual(last.getTrimBox(), { x: 20, y: 26, width: 404, height: 336 });
const layers = merged.catalog.lookup(key('OCProperties'), PDFDict);
const groups = layers.lookup(key('OCGs'), PDFArray);
const layerDefaults = layers.lookup(key('D'), PDFDict);
assert.equal(layerDefaults.lookup(key('ON'), PDFArray).get(0), groups.get(0));
assert.equal(layerDefaults.lookup(key('OFF'), PDFArray).get(0), groups.get(1));

for (const [index, bytes] of sourceBytes.entries()) {
  const source = await PDFDocument.load(bytes);
  const sourceStream = source.getPage(0).node.Contents().lookup(0);
  const outputStream = merged.getPage(index).node.Contents().lookup(0);
  assert.deepEqual(outputStream.getContents(), sourceStream.getContents(), 'original page content stream is unchanged');
}

const fields = merged.getForm();
const coverName = fields.getTextField('student.Name');
const worksheetName = fields.getTextField('student+2.Name');
assert.equal(coverName.getText(), 'Cover Name');
assert.equal(worksheetName.getText(), 'Worksheet Name');
assert.ok(worksheetName.isRequired());
assert.equal(fields.getCheckBox('Done').isChecked(), true);
assert.equal(fields.getCheckBox('Done+2').isChecked(), false);
assert.deepEqual(fields.getDropdown('Choice+2').getSelected(), ['B']);

const widgets = worksheetName.acroField.getWidgets();
assert.equal(widgets.length, 2, 'two widgets on different pages still share one answer');
for (const [index, widget] of widgets.entries()) {
  const page = merged.getPage(index + 1);
  assert.equal(widget.P(), page.ref);
  assert.equal(widget.dict.get(key('Parent')), worksheetName.ref);
  assert.ok(page.node.Annots().asArray().some((ref) => merged.context.lookup(ref) === widget.dict));
  assert.ok(widget.getNormalAppearance());
}
const annotation = merged.getPage(1).node.Annots().asArray()
  .map((ref) => merged.context.lookup(ref, PDFDict)).find((dict) => dict.get(key('Subtype')) === key('Link'));
assert.equal(annotation.lookup(key('A'), PDFDict).lookup(key('D'), PDFArray).get(0), last.ref);

const formDict = merged.catalog.lookup(key('AcroForm'), PDFDict);
const fonts = formDict.lookup(key('DR'), PDFDict).lookup(key('Font'), PDFDict);
assert.equal(fonts.lookup(key('Shared'), PDFDict).get(key('BaseFont')), key('Courier'));
assert.equal(fonts.lookup(key('Shared_2'), PDFDict).get(key('BaseFont')), key('Times-Roman'));
const worksheetRoot = worksheetName.acroField.dict.lookup(key('Parent'), PDFDict);
assert.equal(worksheetRoot.lookup(key('DA'), PDFString).decodeText(), '/Shared_2 12 Tf 0 g');

worksheetName.setText('Edited after merging');
const edited = (await PDFDocument.load(await merged.save())).getForm();
assert.equal(edited.getTextField('student.Name').getText(), 'Cover Name');
assert.equal(edited.getTextField('student+2.Name').getText(), 'Edited after merging');

await assert.rejects(() => mergePdfFiles([files[0]], PDFLib), /at least two PDFs/);
await assert.rejects(() => mergePdfFiles([files[0], new File(['not a PDF'], 'Broken.pdf')], PDFLib), /Broken\.pdf could not be opened/);

cover.catalog.lookup(key('AcroForm'), PDFDict).set(key('XFA'), cover.context.obj([]));
const xfa = new File([await cover.save({ updateFieldAppearances: false })], 'XFA.pdf');
await assert.rejects(() => mergePdfFiles([files[0], xfa], PDFLib), /XFA\.pdf contains an XFA form/);

const signature = worksheet.context.obj({ Type: 'Sig', Contents: PDFHexString.of('FF') });
const signatureRef = worksheet.context.register(signature);
worksheet.catalog.set(key('Perms'), worksheet.context.obj({ DocMDP: signatureRef }));
const signed = new File([await worksheet.save({ updateFieldAppearances: false })], 'Signed.pdf');
await assert.rejects(() => mergePdfFiles([files[0], signed], PDFLib), /Signed\.pdf has a digital signature/);

let modified = 0;
function directory(name) {
  const entries = new Map();
  return {
    name,
    kind: 'directory',
    entries: () => entries.entries(),
    add(child) { entries.set(child.name, child); return child; },
    async getFileHandle(name, { create } = {}) {
      if (!entries.has(name) && !create) throw new DOMException(name, 'NotFoundError');
      if (!entries.has(name)) {
        let contents = new File([], name, { lastModified: ++modified });
        entries.set(name, {
          kind: 'file',
          async getFile() { return contents; },
          async createWritable() {
            let value;
            return {
              async write(data) { value = data; },
              async close() { contents = new File([value], name, { lastModified: ++modified }); },
              async abort() {},
            };
          },
        });
      }
      return entries.get(name);
    },
  };
}

async function put(directory, name, data) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  await writer.write(data);
  await writer.close();
}

const library = directory('Library');
const subject = library.add(directory('Math'));
const folder = subject.add(directory('Unit 1'));
const otherFolder = library.add(directory('Reading'));
const lonely = subject.add(directory('One page'));
await put(lonely, 'Worksheet.pdf', sourceBytes[1]);
await put(folder, 'Worksheet 10.pdf', sourceBytes[1]);
await put(folder, 'Unit 1 Cover.pdf', sourceBytes[0]);
await put(folder, 'Worksheet 2.pdf', sourceBytes[1]);
await put(folder, 'Unit 1 - Merged.pdf', sourceBytes[1]);
await put(otherFolder, 'Cover.pdf', sourceBytes[0]);
await put(otherFolder, 'Worksheet.pdf', sourceBytes[1]);

let books = await scanPdfFolders(library);
assert.deepEqual(books.map((book) => book.path), ['Library / Math / Unit 1', 'Library / Reading']);
assert.equal(books[0].sources[0].name, 'Unit 1 Cover.pdf');
assert.ok(books[0].sources.findIndex(({ name }) => name === 'Worksheet 2.pdf') <
  books[0].sources.findIndex(({ name }) => name === 'Worksheet 10.pdf'));
const existing = await (await folder.getFileHandle('Unit 1 - Merged.pdf')).getFile();
const saved = await savePdfFolder(books[0], (sources) => mergePdfFiles(sources, PDFLib));
assert.equal(saved.name, 'Unit 1 - Merged - 2.pdf');
assert.equal((await (await folder.getFileHandle(saved.name)).getFile()).size > 0, true);
assert.equal(await (await folder.getFileHandle(existing.name)).getFile(), existing, 'source PDF is unchanged');

books = await scanPdfFolders(library);
assert.equal(books[0].status, 'done');
assert.equal(books[0].sources.length, 4, 'previous outputs are excluded from source PDFs');
assert.equal(books[1].status, 'pending');
await savePdfFolder(books[0], () => assert.fail('already saved folders are skipped'));

await put(folder, saved.name, 'an edited copy of the last merged result');
const rebuilt = await savePdfFolder(books[0], (sources) => mergePdfFiles(sources, PDFLib), { redo: true });
assert.equal(rebuilt.name, 'Unit 1 - Merged - 3.pdf');
assert.equal(await (await (await folder.getFileHandle(saved.name)).getFile()).text(), 'an edited copy of the last merged result');
await put(folder, 'Worksheet 2.pdf', sourceBytes[0]);
books = await scanPdfFolders(library);
assert.equal(books[0].status, 'pending', 'edited sources are ready to merge again');

await assert.rejects(savePdfFolder(books[1], () => { throw new Error('Broken source'); }), /Broken source/);
assert.equal((await scanPdfFolders(library))[1].status, 'pending', 'failed merges leave sources and outputs alone');

const endFolder = library.add(directory('Trailing cover and thumbnails'));
const trailingNames = ['Worksheet 2.pdf', 'Worksheet 10.pdf', 'Y Front.pdf', 'Z Detail 1.pdf', 'Z Detail 2.pdf'];
for (const [index, name] of trailingNames.entries()) await put(endFolder, name, sourceBytes[index === 2 ? 0 : 1]);
const endBook = (rows) => rows.find((row) => row.directory === endFolder);
const standard = endBook(await scanPdfFolders(library));
await savePdfFolder(standard, (sources) => mergePdfFiles(sources, PDFLib));

const options = { coversAtEnd: true, coverCount: 3 };
const reordered = endBook(await scanPdfFolders(library, options));
const expected = [...trailingNames.slice(-3), ...trailingNames.slice(0, -3)];
assert.deepEqual(reordered.sources.map(({ name }) => name), expected);
assert.equal(reordered.status, 'pending', 'an output saved in a different order is ready to rebuild');
await savePdfFolder(reordered, (sources) => {
  assert.deepEqual(sources.map(({ name }) => name), expected, 'save uses the order shown in the list');
  return mergePdfFiles(sources, PDFLib);
});
assert.equal(endBook(await scanPdfFolders(library, options)).status, 'done');
assert.equal(endBook(await scanPdfFolders(library)).status, 'done', 'a saved version for the previous order is still available');
assert.deepEqual(endBook(await scanPdfFolders(library, { ...options, coverCount: 1 })).sources.map(({ name }) => name),
  [trailingNames.at(-1), ...trailingNames.slice(0, -1)]);

const namedFolder = library.add(directory('Named cover and thumbnails'));
const namedSources = ['Z Front Cover.pdf', 'Y Cover thumb1.pdf', 'Y Thumbnail 2.pdf', 'Worksheet 2.pdf', 'Worksheet 10.pdf'];
for (const name of namedSources.toReversed()) await put(namedFolder, name, sourceBytes[0]);
assert.deepEqual((await scanPdfFolders(library)).find((row) => row.directory === namedFolder).sources.map(({ name }) => name),
  namedSources, 'recognized covers and thumbnails come first by default');

console.log('PDF merge QA passed: original content, editable fields, nested saves, and cover and thumbnail order.');
