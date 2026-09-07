import { naturalCompare } from '../js/natural-sort.js';
import { scanBooks } from '../js/fs-scan.js?v=20260902-1';
import { readImageForPdf } from '../js/image-io.js';
import {
  buildBookPdf,
  DEFAULT_SEARCHABLE_TEXT_ENABLED,
  getImagePlacement,
  getPageLayout,
  getPageNumber,
  shouldOcrPage,
  LETTER_HEIGHT,
  LETTER_WIDTH,
} from '../js/pdf-builder.js';
import { parseDirectJpeg, parseDirectRgbPng } from '../js/fast-png-pdf.js';
import { chooseOutputPdfName } from '../js/output-name.js';
import {
  codesToPdfLiteral,
  layoutOcrWords,
  textLayerOperators,
  textWidthAtSize,
  toWinAnsiCodes,
} from '../js/text-layer.js';
import { flattenRecognizedWords, MAX_OCR_WORKERS, recommendedOcrConcurrency } from '../js/ocr.js';

const logEl = document.getElementById('log');
const lines = [];
let failures = 0;

function log(msg, cls) {
  lines.push(cls ? `<span class="${cls}">${msg}</span>` : msg);
  logEl.innerHTML = lines.join('\n');
}

function assert(cond, msg) {
  if (cond) {
    log(`PASS  ${msg}`, 'pass');
  } else {
    failures++;
    log(`FAIL  ${msg}`, 'fail');
  }
}

function approxEqual(a, b, eps = 0.5) {
  return Math.abs(a - b) <= eps;
}

function containsBytes(haystack, needle) {
  outer: for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}

async function makeImageBlob({ width, height, format, alphaCorners }) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (alphaCorners) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#2f6fed';
    ctx.beginPath();
    ctx.ellipse(width / 2, height / 2, width * 0.35, height * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#f2745c');
    grad.addColorStop(1, '#34d399');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }
  return canvas.convertToBlob({ type: format === 'png' ? 'image/png' : 'image/jpeg', quality: 0.95 });
}

async function writeFile(dirHandle, name, blob) {
  const fh = await dirHandle.getFileHandle(name, { create: true });
  const writable = await fh.createWritable();
  await writable.write(blob);
  await writable.close();
}

async function main() {
  // ---- 1. natural sort ----
  const sorted = ['page10.jpg', 'page2.jpg', 'page1.jpg', 'page9.jpg'].sort(naturalCompare);
  assert(
    sorted.join(',') === 'page1.jpg,page2.jpg,page9.jpg,page10.jpg',
    `natural sort orders page2 before page10: got [${sorted.join(', ')}]`
  );

  const opfsRoot = await navigator.storage.getDirectory();
  // Clean slate for repeatable runs
  for await (const [name] of opfsRoot.entries()) {
    await opfsRoot.removeEntry(name, { recursive: true });
  }

  // ---- 2. Build "Test-Book": three square covers + Letter interior ----
  const testBookDir = await opfsRoot.getDirectoryHandle('Test-Book', { create: true });
  const specs = [
    { name: '01-cover.png', width: 1200, height: 1200, format: 'png', alphaCorners: true },
    { name: '02-cover.jpg', width: 1200, height: 1200, format: 'jpg' },
    { name: '3-cover.jpg', width: 1200, height: 1200, format: 'jpg' },
    { name: '10-page.jpg', width: 600, height: 900, format: 'jpg' },
  ];
  for (const spec of specs) {
    const blob = await makeImageBlob(spec);
    await writeFile(testBookDir, spec.name, blob);
  }

  // ---- 3. Build "Already-Done" book with a pre-existing .done marker ----
  const doneBookDir = await opfsRoot.getDirectoryHandle('Already-Done', { create: true });
  await writeFile(doneBookDir, 'a.jpg', await makeImageBlob({ width: 400, height: 600, format: 'jpg' }));
  await writeFile(
    doneBookDir,
    '.done',
    new Blob([JSON.stringify({
      processedAt: new Date().toISOString(),
      imageCount: 1,
      pdfFile: 'Already-Done.pdf',
      squareCoverCount: 3,
      pageNumbersEnabled: false,
      searchableTextEnabled: false,
      ocrLanguage: null,
      quality: 'original',
      formatVersion: 5,
    })])
  );

  // A format-4 marker predates the searchable-text setting: it cannot prove
  // whether its PDF matches the current OCR choice, so it must be rebuilt.
  const legacyDoneDir = await opfsRoot.getDirectoryHandle('Legacy-Done', { create: true });
  await writeFile(legacyDoneDir, 'a.jpg', await makeImageBlob({ width: 400, height: 600, format: 'jpg' }));
  await writeFile(legacyDoneDir, 'Legacy-Done.pdf', new Blob(['old Bindery PDF']));
  await writeFile(
    legacyDoneDir,
    '.done',
    new Blob([JSON.stringify({
      processedAt: new Date().toISOString(),
      imageCount: 1,
      pdfFile: 'Legacy-Done.pdf',
      squareCoverCount: 3,
      pageNumbersEnabled: true,
      quality: 'original',
      formatVersion: 4,
    })])
  );

  // ---- 4. Build "Bad-Book" with a corrupt image to test error isolation ----
  const badBookDir = await opfsRoot.getDirectoryHandle('Bad-Book', { create: true });
  await writeFile(badBookDir, 'broken.jpg', new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]));

  // ---- 5. Non-image folder should be skipped entirely ----
  const emptyDir = await opfsRoot.getDirectoryHandle('Not-A-Book', { create: true });
  await writeFile(emptyDir, 'notes.txt', new Blob(['hello']));

  // ---- 6. A nested image folder must be found recursively ----
  const collectionDir = await opfsRoot.getDirectoryHandle('Collection', { create: true });
  const nestedBookDir = await collectionDir.getDirectoryHandle('Nested-Book', { create: true });
  await writeFile(nestedBookDir, '001-cover.jpg', await makeImageBlob({ width: 400, height: 600, format: 'jpg' }));

  // ---- 7. Existing client PDF marks a book done but must remain protected ----
  const pdfOnlyDir = await opfsRoot.getDirectoryHandle('Client-PDF-Book', { create: true });
  await writeFile(pdfOnlyDir, '001-cover.jpg', await makeImageBlob({ width: 400, height: 600, format: 'jpg' }));
  await writeFile(pdfOnlyDir, 'Client-PDF-Book.pdf', new Blob(['client-owned PDF']));

  // ---- scanBooks ----
  const books = await scanBooks(opfsRoot);
  assert(books.length === 6, `scanBooks finds all 6 books, including nested and PDF-complete folders; got ${books.length}: [${books.map(b=>b.relativePath).join(', ')}]`);

  const testBook = books.find((b) => b.name === 'Test-Book');
  const alreadyDone = books.find((b) => b.name === 'Already-Done');
  const legacyDone = books.find((b) => b.name === 'Legacy-Done');
  const badBook = books.find((b) => b.name === 'Bad-Book');
  const nestedBook = books.find((b) => b.name === 'Nested-Book');
  const clientPdfBook = books.find((b) => b.name === 'Client-PDF-Book');

  assert(!!testBook && testBook.status === 'pending' && testBook.imageCount === 4, 'Test-Book scanned as pending with 4 images');
  assert(!!alreadyDone && alreadyDone.status === 'done', 'Already-Done scanned as done (has .done marker)');
  assert(
    !!legacyDone && legacyDone.status === 'pending' && /older Bindery version/i.test(legacyDone.notice),
    'legacy .done marker is automatically queued for rebuild with an upgrade notice'
  );
  assert(!!badBook && badBook.status === 'pending' && badBook.imageCount === 1, 'Bad-Book scanned as pending with 1 (corrupt) image');
  assert(!!nestedBook && nestedBook.relativePath === 'Collection / Nested-Book', 'nested book is discovered with its relative path');
  assert(!!clientPdfBook && clientPdfBook.status === 'done', 'folder with images and an existing PDF is marked done');
  assert(clientPdfBook.generatedPdfName === null, 'client PDF is not claimed as Bindery-owned without a .done record');
  assert(chooseOutputPdfName(clientPdfBook) === 'Client-PDF-Book - Bindery.pdf', 'redo chooses a separate Bindery filename and protects the client PDF');
  assert(
    chooseOutputPdfName({ ...clientPdfBook, pdfNames: [...clientPdfBook.pdfNames, 'Client-PDF-Book - Bindery.pdf'] }) === 'Client-PDF-Book - Bindery 2.pdf',
    'redo chooses a numbered Bindery filename when the first safe name already exists'
  );
  assert(chooseOutputPdfName(alreadyDone) === 'Already-Done.pdf', 'a PDF named by Bindery .done metadata may be overwritten on redo');
  assert(chooseOutputPdfName(legacyDone) === 'Legacy-Done.pdf', 'legacy Bindery PDF is safely overwritten during its automatic rebuild');

  assert(
    testBook.imageHandles.map((h) => h.name).join(',') === '01-cover.png,02-cover.jpg,3-cover.jpg,10-page.jpg',
    `Test-Book images naturally sorted with cover first: [${testBook.imageHandles.map((h) => h.name).join(', ')}]`
  );

  // ---- readImageForPdf: alpha flatten check ----
  const coverFile = await testBook.imageHandles[0].handle.getFile();
  const coverResult = await readImageForPdf(coverFile);
  assert(coverResult.width === 1200 && coverResult.height === 1200, `square cover dimensions read correctly (${coverResult.width}x${coverResult.height})`);

  const flattenedBitmap = await createImageBitmap(new Blob([coverResult.bytes]));
  const checkCanvas = new OffscreenCanvas(flattenedBitmap.width, flattenedBitmap.height);
  const checkCtx = checkCanvas.getContext('2d');
  checkCtx.drawImage(flattenedBitmap, 0, 0);
  const cornerPixel = checkCtx.getImageData(2, 2, 1, 1).data; // was fully transparent originally
  assert(
    cornerPixel[0] === 255 && cornerPixel[1] === 255 && cornerPixel[2] === 255 && cornerPixel[3] === 255,
    `PNG alpha corner flattened to opaque white: rgba(${cornerPixel[0]},${cornerPixel[1]},${cornerPixel[2]},${cornerPixel[3]})`
  );

  const jpegResult = await readImageForPdf(await (await testBook.imageHandles[1].handle.getFile()));
  assert(jpegResult.type === 'jpg', 'JPEG passed through without re-encoding (type=jpg)');

  // ---- buildBookPdf: three square cover pages followed by Letter interiors ----
  const processedPages = [];
  const pdfBytes = await buildBookPdf(testBook.imageHandles, window.PDFLib, {
    onPageProcessed: (page) => processedPages.push(page),
  });
  const loaded = await window.PDFLib.PDFDocument.load(pdfBytes);
  const pages = loaded.getPages();
  assert(pages.length === 4, `built PDF has 4 pages, got ${pages.length}`);

  pages.forEach((page, i) => {
    const { width, height } = page.getSize();
    const expectedHeight = i < 3 ? LETTER_WIDTH : LETTER_HEIGHT;
    assert(approxEqual(width, LETTER_WIDTH) && approxEqual(height, expectedHeight),
      `page ${i + 1} has expected dimensions (${width.toFixed(1)}x${height.toFixed(1)}pt)`);
  });

  const coverLayout = getPageLayout(specs[0].name, specs[0].width, specs[0].height, 0);
  assert(coverLayout.kind === 'square-cover' && coverLayout.pageHeight === LETTER_WIDTH,
    'square first image is recognized as a square cover page');
  const coverPlacement = getImagePlacement(
    specs[0].width,
    specs[0].height,
    coverLayout.fillPage,
    coverLayout.pageWidth,
    coverLayout.pageHeight
  );
  assert(
    approxEqual(coverPlacement.width, LETTER_WIDTH) && approxEqual(coverPlacement.height, LETTER_WIDTH) &&
      approxEqual(coverPlacement.x, 0) && approxEqual(coverPlacement.y, 0),
    'square cover fills the square PDF page exactly without cropping or white bars'
  );
  const mismatchedCoverPlacement = getImagePlacement(1200, 1500, coverLayout.fillPage, LETTER_WIDTH, LETTER_WIDTH);
  assert(
    mismatchedCoverPlacement.width <= LETTER_WIDTH && mismatchedCoverPlacement.height <= LETTER_WIDTH,
    'even a non-square image selected as a cover is contained instead of cropped'
  );
  const insidePlacement = getImagePlacement(specs[3].width, specs[3].height, false);
  assert(
    insidePlacement.width <= LETTER_WIDTH && insidePlacement.height <= LETTER_HEIGHT,
    'interior pages fit completely inside Letter without cutting worksheet content'
  );
  assert(getPageNumber(0, 3, true) === null && getPageNumber(2, 3, true) === null,
    'square covers never receive page numbers');
  assert(getPageNumber(3, 3, true) === 1 && getPageNumber(9, 3, true) === 7,
    'interior numbering starts at 1 immediately after the selected covers');
  assert(getPageNumber(3, 3, false) === null,
    'page numbering can be switched off');
  assert(getPageNumber(3, 3) === null,
    'page numbering is off by default');
  assert(
    processedPages[3].pageNumber === null &&
      approxEqual(processedPages[3].placement.x, insidePlacement.x) &&
      approxEqual(processedPages[3].placement.y, insidePlacement.y) &&
      approxEqual(processedPages[3].placement.width, insidePlacement.width) &&
      approxEqual(processedPages[3].placement.height, insidePlacement.height),
    'default output leaves the interior image geometry completely unchanged'
  );

  // A pages-only folder can explicitly choose zero covers.
  const pagesOnlyHandles = [
    { name: 'page-001.jpg', handle: { getFile: async () => new File([await makeImageBlob({ width: 850, height: 1100, format: 'jpg' })], 'page-001.jpg', { type: 'image/jpeg' }) } },
    { name: 'page-002.jpg', handle: { getFile: async () => new File([await makeImageBlob({ width: 850, height: 1100, format: 'jpg' })], 'page-002.jpg', { type: 'image/jpeg' }) } },
  ];
  const pagesOnlyPdfBytes = await buildBookPdf(pagesOnlyHandles, window.PDFLib, { squareCoverCount: 0 });
  const pagesOnlyPdf = await window.PDFLib.PDFDocument.load(pagesOnlyPdfBytes);
  pagesOnlyPdf.getPages().forEach((page, index) => {
    const { width, height } = page.getSize();
    assert(approxEqual(width, LETTER_WIDTH) && approxEqual(height, LETTER_HEIGHT),
      `pages-only PDF page ${index + 1} remains US Letter`);
  });

  // A one-cover book keeps only its first page square.
  const oneCoverPdfBytes = await buildBookPdf(testBook.imageHandles, window.PDFLib, { squareCoverCount: 1 });
  const oneCoverPdf = await window.PDFLib.PDFDocument.load(oneCoverPdfBytes);
  oneCoverPdf.getPages().forEach((page, index) => {
    const { width, height } = page.getSize();
    const expectedHeight = index === 0 ? LETTER_WIDTH : LETTER_HEIGHT;
    assert(
      approxEqual(width, LETTER_WIDTH) && approxEqual(height, expectedHeight),
      `one-cover setting gives page ${index + 1} the expected dimensions`
    );
  });

  // ---- direct RGB PNG engine ----
  const directPngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGOI1t0SrbuFAUIBACE6BPHDfGk/AAAAAElFTkSuQmCC';
  const directPngBytes = Uint8Array.from(atob(directPngBase64), (char) => char.charCodeAt(0));
  const parsedDirectPng = parseDirectRgbPng(directPngBytes, 'cover-square.png');
  assert(
    parsedDirectPng.supported && parsedDirectPng.width === 2 && parsedDirectPng.height === 2,
    'square RGB PNG is accepted by the direct embedding engine'
  );
  const directPdfBytes = await buildBookPdf(
    [{ name: 'cover-square.png', handle: { getFile: async () => new File([directPngBytes], 'cover-square.png', { type: 'image/png' }) } }],
    window.PDFLib,
    { title: 'Direct PNG Test' }
  );
  const directPdf = await window.PDFLib.PDFDocument.load(directPdfBytes);
  assert(directPdf.getPageCount() === 1, 'direct PNG engine creates a readable one-page PDF');
  const directPageSize = directPdf.getPage(0).getSize();
  assert(
    approxEqual(directPageSize.width, LETTER_WIDTH) && approxEqual(directPageSize.height, LETTER_WIDTH),
    'direct PNG engine preserves the square cover page size'
  );
  assert(
    new TextDecoder().decode(directPdfBytes).includes('Bindery direct image engine'),
    'direct image engine is selected for compatible generated PNG files'
  );

  // ---- mixed JPEG + RGB PNG direct engine ----
  const parsedDirectJpeg = parseDirectJpeg(jpegResult.bytes, 'cover.jpg');
  assert(
    parsedDirectJpeg.supported && parsedDirectJpeg.width === 1200 && parsedDirectJpeg.height === 1200,
    'standard RGB JPEG is accepted by the direct image engine'
  );
  const mixedDirectPdfBytes = await buildBookPdf(
    [
      { name: 'cover.png', handle: { getFile: async () => new File([directPngBytes], 'cover.png', { type: 'image/png' }) } },
      { name: 'thumbnail.jpg', handle: { getFile: async () => new File([jpegResult.bytes], 'thumbnail.jpg', { type: 'image/jpeg' }) } },
    ],
    window.PDFLib,
    { squareCoverCount: 2, title: 'Mixed Direct Test' }
  );
  const mixedDirectPdf = await window.PDFLib.PDFDocument.load(mixedDirectPdfBytes);
  assert(mixedDirectPdf.getPageCount() === 2, 'mixed direct engine creates a readable JPEG + PNG PDF');
  assert(
    new TextDecoder().decode(mixedDirectPdfBytes).includes('Bindery direct image engine'),
    'mixed JPEG + PNG book stays on the fast direct engine'
  );
  assert(
    containsBytes(mixedDirectPdfBytes, jpegResult.bytes),
    'mixed direct engine embeds the original JPEG bytes without re-encoding'
  );

  // ---- optional page numbering on the fast direct engine ----
  const numberedHandles = [
    { name: 'cover.png', handle: { getFile: async () => new File([directPngBytes], 'cover.png', { type: 'image/png' }) } },
    { name: 'page-001.jpg', handle: { getFile: async () => new File([jpegResult.bytes], 'page-001.jpg', { type: 'image/jpeg' }) } },
    { name: 'page-002.jpg', handle: { getFile: async () => new File([jpegResult.bytes], 'page-002.jpg', { type: 'image/jpeg' }) } },
  ];
  const numberedPlacements = [];
  const numberedPdfBytes = await buildBookPdf(numberedHandles, window.PDFLib, {
    squareCoverCount: 1,
    pageNumbersEnabled: true,
    onPageProcessed: (page) => numberedPlacements.push(page),
  });
  const numberedPdfText = new TextDecoder().decode(numberedPdfBytes);
  assert(
    numberedPdfText.includes('(1) Tj') && numberedPdfText.includes('(2) Tj'),
    'fast direct engine writes consecutive interior page numbers after the cover'
  );
  assert(
    numberedPdfText.includes('/BaseFont /Helvetica-Bold'),
    'page numbers use a consistent, noticeable Helvetica Bold style'
  );
  assert(
    numberedPlacements[0].pageNumber === null &&
      numberedPlacements[1].pageNumber === 1 &&
      numberedPlacements[2].pageNumber === 2,
    'fast direct engine reports cover and interior numbering correctly'
  );
  assert(
    containsBytes(numberedPdfBytes, jpegResult.bytes),
    'adding page numbers still embeds the original JPEG bytes without re-encoding'
  );

  const unnumberedPlacements = [];
  const unnumberedPdfBytes = await buildBookPdf(numberedHandles, window.PDFLib, {
    squareCoverCount: 1,
    pageNumbersEnabled: false,
    onPageProcessed: (page) => unnumberedPlacements.push(page),
  });
  assert(
    !new TextDecoder().decode(unnumberedPdfBytes).includes('/BaseFont /Helvetica'),
    'turning page numbers off omits the numbering font and footer content'
  );
  numberedPlacements.forEach((page, index) => {
    const unnumbered = unnumberedPlacements[index];
    assert(
      approxEqual(page.placement.x, unnumbered.placement.x) &&
        approxEqual(page.placement.y, unnumbered.placement.y) &&
        approxEqual(page.placement.width, unnumbered.placement.width) &&
        approxEqual(page.placement.height, unnumbered.placement.height),
      `numbering leaves page ${index + 1} image placement exactly unchanged`
    );
  });

  // ---- high-quality compression: same dimensions/order, smaller output ----
  const compressedProcessedPages = [];
  const compressedPdfBytes = await buildBookPdf(testBook.imageHandles, window.PDFLib, {
    compress: true,
    pageNumbersEnabled: true,
    onPageProcessed: (page) => compressedProcessedPages.push(page),
  });
  const compressedPdf = await window.PDFLib.PDFDocument.load(compressedPdfBytes);
  const compressedPages = compressedPdf.getPages();
  assert(compressedPages.length === pages.length, `compressed PDF keeps all ${pages.length} pages`);
  compressedPages.forEach((page, i) => {
    const originalSize = pages[i].getSize();
    const compressedSize = page.getSize();
    assert(
      approxEqual(originalSize.width, compressedSize.width) && approxEqual(originalSize.height, compressedSize.height),
      `compressed page ${i + 1} keeps its original dimensions`
    );
  });
  assert(
    compressedPdfBytes.length < pdfBytes.length,
    `high-quality compression reduces fixture PDF size (${pdfBytes.length} → ${compressedPdfBytes.length} bytes)`
  );
  assert(
    compressedProcessedPages[3].pageNumber === 1 &&
      approxEqual(compressedProcessedPages[3].placement.x, processedPages[3].placement.x) &&
      approxEqual(compressedProcessedPages[3].placement.y, processedPages[3].placement.y) &&
      approxEqual(compressedProcessedPages[3].placement.width, processedPages[3].placement.width) &&
      approxEqual(compressedProcessedPages[3].placement.height, processedPages[3].placement.height),
    'compatibility/compressed numbering also leaves image placement unchanged'
  );

  // ---- write PDF + .done back into OPFS, exactly like the app does ----
  const pdfHandle = await testBookDir.getFileHandle('Test-Book.pdf', { create: true });
  const pdfWritable = await pdfHandle.createWritable();
  await pdfWritable.write(pdfBytes);
  await pdfWritable.close();
  const writtenFile = await (await testBookDir.getFileHandle('Test-Book.pdf')).getFile();
  assert(writtenFile.size === pdfBytes.length, `PDF written back into OPFS book folder (${writtenFile.size} bytes)`);

  // ---- selecting a book folder directly (instead of its parent library) ----
  const directBookDir = await opfsRoot.getDirectoryHandle('Direct-Selected-Book', { create: true });
  await writeFile(directBookDir, '001-cover.png', await makeImageBlob({ width: 500, height: 700, format: 'png' }));
  await writeFile(directBookDir, '002-page.png', await makeImageBlob({ width: 500, height: 700, format: 'png' }));
  const directBooks = await scanBooks(directBookDir);
  assert(
    directBooks.length === 1 && directBooks[0].name === 'Direct-Selected-Book' && directBooks[0].imageCount === 2,
    'selecting the image-containing book folder directly discovers it as one book'
  );


  // ================= Searchable text (OCR) =================

  // ---- text-layer unit checks: encoding, widths, geometry, reading order ----
  assert(DEFAULT_SEARCHABLE_TEXT_ENABLED === false, 'searchable text (OCR) is off by default');
  assert(
    shouldOcrPage(0, 1) === false && shouldOcrPage(1, 1) === true && shouldOcrPage(2, 3) === false && shouldOcrPage(3, 3) === true,
    'OCR skips the selected square covers and starts on the first interior page'
  );

  const accented = toWinAnsiCodes('Bogotá');
  assert(
    accented.text === 'Bogotá' && accented.codes.join(',') === '66,111,103,111,116,225',
    `accented text is encoded as WinAnsi without corruption: [${accented.codes.join(',')}]`
  );
  const curly = toWinAnsiCodes('folder’s “quoted” — dash');
  assert(
    curly.text === 'folder’s “quoted” — dash' &&
      curly.codes.includes(0x92) && curly.codes.includes(0x93) && curly.codes.includes(0x97),
    'typographic quotes and dashes map onto their WinAnsi code points'
  );
  const substituted = toWinAnsiCodes('Łord ≤ 5');
  assert(substituted.text === 'Lord <= 5', `characters outside WinAnsi fall back safely: "${substituted.text}"`);
  const dropped = toWinAnsiCodes('ok中文');
  assert(dropped.text === 'ok', 'characters with no safe fallback are dropped rather than corrupted');
  // Standard Adobe Helvetica advances: H = 722, i = 222, space = 278, á = 556.
  assert(
    approxEqual(textWidthAtSize(toWinAnsiCodes('Hi á').codes, 1000), 722 + 222 + 278 + 556, 0.001),
    `Helvetica advance widths match the standard font metrics (got ${textWidthAtSize(toWinAnsiCodes('Hi á').codes, 1000)})`
  );
  assert(
    codesToPdfLiteral(toWinAnsiCodes('a(b)c\\dá').codes) === '(a\\(b\\)c\\\\d\\341)',
    `PDF string literals escape parentheses, backslashes, and high bytes: ${codesToPdfLiteral(toWinAnsiCodes('a(b)c\\dá').codes)}`
  );

  // Coordinate conversion: image pixels (top-left origin) into the *existing*
  // image placement in PDF points (bottom-left origin).
  const geometryPlacement = { x: 10, y: 20, width: 400, height: 800 };
  const geometryItems = layoutOcrWords(
    [
      { text: 'top', bbox: { x0: 0, y0: 0, x1: 100, y1: 50 }, confidence: 90 },
      { text: 'bottom', bbox: { x0: 100, y0: 350, x1: 200, y1: 400 }, confidence: 90 },
    ],
    { imageWidth: 200, imageHeight: 400, placement: geometryPlacement }
  );
  assert(geometryItems.length === 2, 'every OCR word becomes one positioned text run');
  assert(
    approxEqual(geometryItems[0].x, 10, 1e-6) &&
      approxEqual(geometryItems[0].y, 20 + 800 - (50 / 400) * 800, 1e-6),
    `top-left word maps to the documented pdfX/pdfY formula (${geometryItems[0].x}, ${geometryItems[0].y})`
  );
  assert(
    approxEqual(geometryItems[1].x, 10 + (100 / 200) * 400, 1e-6) &&
      approxEqual(geometryItems[1].y, 20, 1e-6),
    'bottom-right word lands on the bottom edge of the image rectangle'
  );
  assert(
    approxEqual(geometryItems[0].size, (50 / 400) * 800, 1e-6),
    'font size approximates the OCR word box height'
  );
  assert(
    approxEqual(
      (textWidthAtSize(toWinAnsiCodes('top').codes, geometryItems[0].size) * geometryItems[0].horizontalScale) / 100,
      (100 / 200) * 400,
      0.01
    ),
    'horizontal scaling makes the invisible word match its OCR box width'
  );
  assert(
    geometryItems.map((item) => item.text.trim()).join(' ') === 'top bottom',
    'text runs keep the reading order they were given'
  );
  const noBoxItems = layoutOcrWords(
    [{ text: 'zero', bbox: { x0: 5, y0: 5, x1: 5, y1: 5 } }, { text: '', bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }],
    { imageWidth: 200, imageHeight: 400, placement: geometryPlacement }
  );
  assert(noBoxItems.length === 0, 'degenerate and empty OCR boxes are skipped instead of producing broken text');

  const layerOps = textLayerOperators(geometryItems, 'F1').join('\n');
  assert(
    layerOps.startsWith('q\nBT\n3 Tr') && layerOps.endsWith('ET\nQ'),
    'the text layer uses rendering mode 3 and is isolated inside q/Q'
  );
  assert(textLayerOperators([], 'F1').length === 0, 'a page with no OCR words emits no text operators at all');

  assert(
    flattenRecognizedWords({
      blocks: [{ paragraphs: [{ lines: [{ words: [
        { text: 'first', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, confidence: 90 },
        { text: '  ', bbox: { x0: 1, y0: 0, x1: 2, y1: 1 }, confidence: 10 },
        { text: 'second', bbox: { x0: 2, y0: 0, x1: 3, y1: 1 }, confidence: 88 },
      ] }] }] }],
    }).map((word) => word.text).join(' ') === 'first second',
    'recognized words are flattened in block/line reading order, skipping blank results'
  );

  // ---- end-to-end: the fast direct engine with searchable text on ----
  const ocrHandles = [
    { name: 'cover.png', handle: { getFile: async () => new File([directPngBytes], 'cover.png', { type: 'image/png' }) } },
    { name: 'page-001.jpg', handle: { getFile: async () => new File([jpegResult.bytes], 'page-001.jpg', { type: 'image/jpeg' }) } },
    { name: 'page-002.jpg', handle: { getFile: async () => new File([jpegResult.bytes], 'page-002.jpg', { type: 'image/jpeg' }) } },
  ];
  const fakeWords = (label) => [
    { text: label, bbox: { x0: 100, y0: 100, x1: 500, y1: 180 }, confidence: 92 },
    { text: 'Bogotá', bbox: { x0: 100, y0: 220, x1: 520, y1: 300 }, confidence: 88 },
  ];

  const ocrOffPages = [];
  const ocrOffBytes = await buildBookPdf(ocrHandles, window.PDFLib, {
    squareCoverCount: 1,
    pageNumbersEnabled: true,
    title: 'OCR comparison',
    onPageProcessed: (page) => ocrOffPages.push(page),
  });
  const ocrOffText = new TextDecoder('latin1').decode(ocrOffBytes);
  assert(!ocrOffText.includes('3 Tr'), 'with OCR off no invisible text layer is written');
  assert(
    !ocrOffText.includes('/BaseFont /Helvetica >>') && !ocrOffText.includes('/BaseFont /Helvetica /Encoding'),
    'with OCR off the text-layer font object is not created'
  );
  assert(
    ocrOffPages.every((page) => (page.textLayerWordCount || 0) === 0),
    'with OCR off every page reports zero text-layer words'
  );

  let ocrCallCount = 0;
  const ocrRequestedIndexes = [];
  const ocrOnPages = [];
  const ocrOnBytes = await buildBookPdf(ocrHandles, window.PDFLib, {
    squareCoverCount: 1,
    pageNumbersEnabled: true,
    title: 'OCR comparison',
    searchableText: true,
    recognizeWords: async (_file, meta) => {
      ocrCallCount += 1;
      ocrRequestedIndexes.push(meta.pageIndex);
      return fakeWords(`Sentence${meta.pageIndex}`);
    },
    onPageProcessed: (page) => ocrOnPages.push(page),
  });
  const ocrOnText = new TextDecoder('latin1').decode(ocrOnBytes);

  assert(
    ocrCallCount === 2 && ocrRequestedIndexes.join(',') === '1,2',
    `OCR runs only on interior pages, in order: [${ocrRequestedIndexes.join(', ')}]`
  );
  assert(
    (ocrOnPages[0].textLayerWordCount || 0) === 0 &&
      ocrOnPages[1].textLayerWordCount === 2 &&
      ocrOnPages[2].textLayerWordCount === 2,
    'the square cover carries no text layer while both interiors do'
  );
  assert(ocrOnText.includes('3 Tr'), 'OCR text is written with PDF rendering mode 3 (invisible)');
  assert(
    ocrOnText.includes('/F1 ') && ocrOnText.includes('/BaseFont /Helvetica /Encoding /WinAnsiEncoding'),
    'the invisible text layer references a WinAnsi-encoded Helvetica font'
  );
  assert(
    ocrOnText.includes('(Sentence1 ) Tj') && ocrOnText.includes('(Sentence2 ) Tj'),
    'each interior page carries its own recognized words as real PDF text operators'
  );
  assert(
    ocrOnText.includes('(Bogot\\341 ) Tj'),
    'accented recognized text is written as correctly encoded PDF text, not mangled'
  );
  const firstInteriorContent = ocrOnText.slice(ocrOnText.indexOf('(Sentence1 ) Tj'));
  assert(
    firstInteriorContent.indexOf('(1) Tj') > 0,
    'the visible page number is written after the worksheet text, not spliced into it'
  );
  assert(
    ocrOnText.includes('Bindery direct image engine'),
    'searchable text does not push the book off the fast direct image engine'
  );
  assert(
    containsBytes(ocrOnBytes, jpegResult.bytes),
    'the original JPEG bytes are still embedded verbatim with OCR on'
  );
  const parsedOcrCoverPng = parseDirectRgbPng(directPngBytes, 'cover.png');
  const coverIdat = new Uint8Array(parsedOcrCoverPng.idatLength);
  {
    let offset = 0;
    for (const chunk of parsedOcrCoverPng.idatChunks) { coverIdat.set(chunk, offset); offset += chunk.length; }
  }
  assert(
    containsBytes(ocrOnBytes, coverIdat),
    'the original PNG IDAT stream is still embedded verbatim with OCR on'
  );

  ocrOnPages.forEach((page, index) => {
    const off = ocrOffPages[index];
    assert(
      page.placement.x === off.placement.x &&
        page.placement.y === off.placement.y &&
        page.placement.width === off.placement.width &&
        page.placement.height === off.placement.height &&
        page.pageWidth === off.pageWidth &&
        page.pageHeight === off.pageHeight,
      `page ${index + 1} image placement and page size are identical with OCR off and on`
    );
  });
  const ocrOnPdf = await window.PDFLib.PDFDocument.load(ocrOnBytes);
  ocrOnPdf.getPages().forEach((page, index) => {
    const { width, height } = page.getSize();
    const expectedHeight = index === 0 ? LETTER_WIDTH : LETTER_HEIGHT;
    assert(
      width === LETTER_WIDTH && height === expectedHeight,
      `searchable page ${index + 1} keeps its exact size (${width} x ${height} pt)`
    );
  });
  assert(
    ocrOnPages[0].pageNumber === null && ocrOnPages[1].pageNumber === 1 && ocrOnPages[2].pageNumber === 2,
    'page numbering still starts at 1 on the first interior page with OCR on'
  );

  // With OCR on but nothing recognized, output must stay identical to OCR off.
  const emptyOcrBytes = await buildBookPdf(ocrHandles, window.PDFLib, {
    squareCoverCount: 1,
    pageNumbersEnabled: true,
    title: 'OCR comparison',
    searchableText: true,
    recognizeWords: async () => [],
  });
  assert(
    emptyOcrBytes.length === ocrOffBytes.length,
    `a book with no recognizable text produces the same output as OCR off (${ocrOffBytes.length} vs ${emptyOcrBytes.length} bytes)`
  );

  // ---- compatibility (pdf-lib) path also gets an invisible text layer ----
  const compatOffPages = [];
  const compatOffBytes = await buildBookPdf(ocrHandles, window.PDFLib, {
    compress: true,
    squareCoverCount: 1,
    pageNumbersEnabled: true,
    onPageProcessed: (page) => compatOffPages.push(page),
  });
  const compatOnPages = [];
  const compatOnBytes = await buildBookPdf(ocrHandles, window.PDFLib, {
    compress: true,
    squareCoverCount: 1,
    pageNumbersEnabled: true,
    searchableText: true,
    recognizeWords: async (_file, meta) => fakeWords(`Compat${meta.pageIndex}`),
    onPageProcessed: (page) => compatOnPages.push(page),
  });
  const compatOnPdf = await window.PDFLib.PDFDocument.load(compatOnBytes);
  assert(compatOnPdf.getPageCount() === 3, 'the compatibility path still produces a readable PDF with OCR on');
  assert(
    compatOnBytes.length > compatOffBytes.length,
    'the compatibility path actually adds text content when OCR is on'
  );
  compatOnPages.forEach((page, index) => {
    const off = compatOffPages[index];
    assert(
      approxEqual(page.placement.x, off.placement.x, 1e-9) &&
        approxEqual(page.placement.y, off.placement.y, 1e-9) &&
        approxEqual(page.placement.width, off.placement.width, 1e-9) &&
        approxEqual(page.placement.height, off.placement.height, 1e-9),
      `compatibility page ${index + 1} keeps identical image placement with OCR on`
    );
  });
  assert(
    (compatOnPages[0].textLayerWordCount || 0) === 0 && compatOnPages[1].textLayerWordCount === 2,
    'the compatibility path also skips covers and writes text on interiors'
  );

  // ---- parallel OCR: faster, but page order and failures must not change ----
  assert(
    recommendedOcrConcurrency(1) === 1 && recommendedOcrConcurrency(4) === 1 &&
      recommendedOcrConcurrency(12) === 4 && recommendedOcrConcurrency(64) === MAX_OCR_WORKERS,
    `OCR worker count scales with cores and stays capped at ${MAX_OCR_WORKERS}`
  );
  assert(
    recommendedOcrConcurrency(0) === 1 && recommendedOcrConcurrency(NaN) === 1,
    'an unknown or single-core machine falls back to one OCR worker'
  );

  // Deliberately finish the LAST page first: with real parallelism, pages come
  // back out of order, and the PDF must not.
  let inFlight = 0;
  let peakInFlight = 0;
  const parallelBytes = await buildBookPdf(ocrHandles, window.PDFLib, {
    squareCoverCount: 1,
    pageNumbersEnabled: true,
    title: 'OCR comparison',
    searchableText: true,
    ocrConcurrency: 4,
    recognizeWords: async (_file, meta) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      // page 1 is slow, page 2 is instant -> page 2 resolves first
      await new Promise((resolve) => setTimeout(resolve, meta.pageIndex === 1 ? 60 : 0));
      inFlight -= 1;
      return fakeWords(`Sentence${meta.pageIndex}`);
    },
  });
  assert(peakInFlight > 1, `pages are recognized concurrently (peak in flight: ${peakInFlight})`);
  const parallelText = new TextDecoder('latin1').decode(parallelBytes);
  assert(
    parallelText.indexOf('(Sentence1 ) Tj') < parallelText.indexOf('(Sentence2 ) Tj'),
    'out-of-order OCR results are still written to the correct pages, in page order'
  );
  assert(
    parallelBytes.length === ocrOnBytes.length,
    `parallel OCR produces the same PDF as serial OCR (${ocrOnBytes.length} vs ${parallelBytes.length} bytes)`
  );

  let parallelFailed = false;
  try {
    await buildBookPdf(ocrHandles, window.PDFLib, {
      squareCoverCount: 1,
      searchableText: true,
      ocrConcurrency: 4,
      recognizeWords: async (_file, meta) => {
        if (meta.pageIndex === 2) throw new Error('worker crashed');
        return fakeWords('ok');
      },
    });
  } catch (err) {
    parallelFailed = /worker crashed/.test(err.message);
  }
  assert(parallelFailed, 'one page failing still fails the whole book when pages run in parallel');

  // ---- a failing OCR engine must fail its book loudly, not silently ----
  let ocrFailed = false;
  try {
    await buildBookPdf(ocrHandles, window.PDFLib, {
      squareCoverCount: 1,
      searchableText: true,
      recognizeWords: async () => { throw new Error('worker crashed'); },
    });
  } catch (err) {
    ocrFailed = /worker crashed/.test(err.message);
  }
  assert(ocrFailed, 'an OCR failure rejects the book instead of writing a fake searchable PDF');

  // ---- error isolation: corrupt image should reject cleanly, not throw uncaught ----
  let corruptThrew = false;
  try {
    await buildBookPdf(badBook.imageHandles, window.PDFLib);
  } catch (err) {
    corruptThrew = true;
  }
  assert(corruptThrew, 'corrupt image causes buildBookPdf to reject (catchable per-book, does not hang)');

  log('');
  log(failures === 0 ? `ALL TESTS PASSED` : `${failures} TEST(S) FAILED`, failures === 0 ? 'pass' : 'fail');
}

main().catch((err) => {
  failures++;
  log(`UNCAUGHT ERROR: ${err && err.stack ? err.stack : err}`, 'fail');
});
