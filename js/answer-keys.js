import { naturalCompare } from './natural-sort.js?v=20260901-1';

export const ANSWER_KEYS_NONE = 'none';
export const ANSWER_KEYS_AUTO = 'auto';
export const ANSWER_KEYS_MANUAL = 'manual';

const PDF_EXT = /\.pdf$/i;
// The direct engine writes its info dictionary last, so the end of the file is
// enough to recognize a PDF Bindery built, whatever it has since been renamed to.
const BINDERY_TAIL_BYTES = 2048;
const BINDERY_CREATOR = '/Creator (Bindery)';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A book's own results sit beside its images, and adding one back would double
// the book. A .done marker names them; older previews are no longer listed there
// once previews are switched off, so Bindery's name patterns are checked as well.
export function ownedPdfNames(book) {
  const marker = book.markerRecord || {};
  const names = [marker.sourcePdfFile, marker.sourcePreviewFile];
  if ((marker.outputMode || 'source') === 'source') names.push(marker.pdfFile, marker.previewFile);
  if (Array.isArray(marker.ownedPdfFiles)) names.push(...marker.ownedPdfFiles);
  return new Set(names.filter((name) => typeof name === 'string').map((name) => name.toLowerCase()));
}

export function isBinderyOutputName(pdfName, bookName) {
  const base = escapeRegExp(bookName);
  return new RegExp(`^${base}( - \\d+| - Bindery( \\d+)?)? - Preview( \\d+)?\\.pdf$`, 'i').test(pdfName)
    || new RegExp(`^${base} - Bindery( \\d+)?\\.pdf$`, 'i').test(pdfName);
}

async function hasBinderyCreator(file) {
  const tail = await file.slice(Math.max(0, file.size - BINDERY_TAIL_BYTES)).text();
  return tail.includes(BINDERY_CREATOR);
}

function bookKey(book) {
  return book.outputPathParts.slice(1).join('\0');
}

// Lists every PDF under the chosen folder. macOS `._name` sidecars and hidden
// folders hold no pages, and a result folder inside the library holds only output.
async function listLibraryPdfs(rootHandle, books, outputFolderNames) {
  const bookKeys = books.map(bookKey);
  const found = [];

  async function walk(directory, parts) {
    let entries;
    try {
      entries = [];
      for await (const entry of directory.entries()) entries.push(entry);
    } catch (err) {
      console.warn(`Could not look for PDFs in ${parts.join(' / ') || rootHandle.name}:`, err);
      return;
    }
    for (const [name, handle] of entries) {
      if (name.startsWith('.') || name === '__MACOSX') continue;
      if (handle.kind === 'directory') {
        const key = [...parts, name].join('\0');
        const holdsBook = bookKeys.some((candidate) => candidate === key || candidate.startsWith(`${key}\0`));
        if (!holdsBook && outputFolderNames.has(name)) continue;
        await walk(handle, [...parts, name]);
      } else if (PDF_EXT.test(name)) {
        found.push({ name, handle, parts });
      }
    }
  }

  await walk(rootHandle, []);
  return found;
}

// The nearest book at or above the PDF wins. A PDF with no book above it belongs
// to a book only when the closest folder holding any book holds exactly one;
// otherwise guessing could put the answers in the wrong book.
function findOwningBook(parts, booksByKey, bookKeys) {
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const book = booksByKey.get(parts.slice(0, depth).join('\0'));
    if (book) return book;
  }
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const prefix = parts.slice(0, depth).join('\0');
    const inside = bookKeys.filter((key) => depth === 0 || key.startsWith(`${prefix}\0`));
    if (inside.length === 1) return booksByKey.get(inside[0]);
    if (inside.length > 1) return null;
  }
  return null;
}

async function describePdf(pdf) {
  const path = [...pdf.parts, pdf.name].join('/');
  try {
    const file = await pdf.handle.getFile();
    return {
      name: pdf.name,
      handle: pdf.handle,
      path,
      size: file.size,
      lastModified: file.lastModified,
      binderyMade: await hasBinderyCreator(file),
    };
  } catch (err) {
    // An unreadable file still appears, and fails its book by name at build time.
    return { name: pdf.name, handle: pdf.handle, path, size: 0, lastModified: 0, binderyMade: false };
  }
}

export async function scanAnswerKeys(rootHandle, books, { outputFolderNames = [] } = {}) {
  const pdfs = await listLibraryPdfs(rootHandle, books, new Set(outputFolderNames));
  const booksByKey = new Map(books.map((book) => [bookKey(book), book]));
  const bookKeys = [...booksByKey.keys()];
  const candidatesByBook = new Map(books.map((book) => [book, []]));
  const byPath = new Map();
  const unmatched = [];

  for (const pdf of pdfs) {
    const key = await describePdf(pdf);
    if (key.binderyMade) continue;
    byPath.set(key.path, key);
    const book = findOwningBook(pdf.parts, booksByKey, bookKeys);
    if (!book) {
      unmatched.push(key);
    } else if (pdf.parts.join('\0') !== bookKey(book)
      || (!ownedPdfNames(book).has(pdf.name.toLowerCase()) && !isBinderyOutputName(pdf.name, book.name))) {
      candidatesByBook.get(book).push(key);
    }
  }

  for (const list of candidatesByBook.values()) list.sort((a, b) => naturalCompare(a.path, b.path));
  unmatched.sort((a, b) => naturalCompare(a.path, b.path));
  return { candidatesByBook, unmatched, byPath };
}

// Compared against the .done marker, so replacing a key file asks for a rebuild.
// No keys gives an empty signature, which is what markers from before this
// feature amount to: they stay done.
export function answerKeySignature(keys) {
  if (!keys || keys.length === 0) return '';
  return JSON.stringify(keys.map(({ path, size, lastModified }) => [path, size, lastModified]));
}

function describeLoadFailure(err) {
  const message = String(err?.message || err);
  if (/encrypt/i.test(message)) return 'it is password-protected or encrypted, so its pages cannot be copied.';
  return 'it is damaged or is not a valid PDF.';
}

async function readKeyDocument(key, PDFLib) {
  let file;
  try {
    file = await key.handle.getFile();
  } catch (err) {
    throw new Error(`Answer key "${key.name}" could not be read. It may have moved. Rescan and try again.`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (!header.includes('%PDF-')) {
    throw new Error(`Answer key "${key.name}" was not added: it is empty or is not a valid PDF.`);
  }
  let document;
  try {
    document = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    throw new Error(`Answer key "${key.name}" was not added: ${describeLoadFailure(err)}`);
  }
  if (document.getPageCount() === 0) {
    throw new Error(`Answer key "${key.name}" was not added: it has no pages.`);
  }
  return { document, size: file.size, lastModified: file.lastModified };
}

// Pages go after the book's own, untouched: no page numbers and no OCR, because
// a key PDF already has its own numbering and text. Keys are read one at a time
// so a long list never holds every key in memory together.
export async function appendAnswerKeys(pdfBytes, keys, PDFLib) {
  const merged = await PDFLib.PDFDocument.load(pdfBytes, { updateMetadata: false });
  const records = [];
  let pagesAdded = 0;
  for (const key of keys) {
    const { document, size, lastModified } = await readKeyDocument(key, PDFLib);
    let pages;
    try {
      pages = await merged.copyPages(document, document.getPageIndices());
    } catch (err) {
      throw new Error(`Answer key "${key.name}" was not added: ${describeLoadFailure(err)}`);
    }
    pages.forEach((page) => merged.addPage(page));
    pagesAdded += pages.length;
    records.push({ name: key.name, path: key.path, size, lastModified, pages: pages.length });
  }
  return { bytes: await merged.save(), records, pagesAdded };
}
