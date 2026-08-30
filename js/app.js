import { scanBooks } from './fs-scan.js?v=20260830-12';
import { buildBookPdf } from './pdf-builder.js?v=20260830-11';
import { runPool } from './pool.js?v=20260830-3';
import { chooseOutputPdfName } from './output-name.js?v=20260830-4';
import { validatePdfHandle } from './pdf-validator.js?v=20260830-11';

// Two books at a time keeps memory stable when each book contains dozens of
// multi-megabyte scans. Higher concurrency can freeze or crash browser tabs.
const CONCURRENCY = 2;
const PDFLib = window.PDFLib;

const els = {
  unsupportedGate: document.getElementById('unsupported-gate'),
  app: document.getElementById('app'),
  emptyState: document.getElementById('empty-state'),
  libraryView: document.getElementById('library-view'),
  chooseFolderBtn: document.getElementById('choose-folder-btn'),
  emptyChooseFolderBtn: document.getElementById('empty-choose-folder-btn'),
  rescanBtn: document.getElementById('rescan-btn'),
  redoAllBtn: document.getElementById('redo-all-btn'),
  processAllBtn: document.getElementById('process-all-btn'),
  qualitySelect: document.getElementById('quality-select'),
  pageFormatSelect: document.getElementById('page-format-select'),
  folderPath: document.getElementById('folder-path'),
  folderPathName: document.getElementById('folder-path-name'),
  bookCount: document.getElementById('book-count'),
  pendingCount: document.getElementById('pending-count'),
  doneCount: document.getElementById('done-count'),
  errorCount: document.getElementById('error-count'),
  errorCountWrap: document.getElementById('error-count-wrap'),
  bookList: document.getElementById('book-list'),
  progressWrap: document.getElementById('progress-wrap'),
  progressBar: document.getElementById('progress-bar'),
  progressCounter: document.getElementById('progress-counter'),
  operationMessage: document.getElementById('operation-message'),
  rowTemplate: document.getElementById('book-row-template'),
};

/** @type {Array<ReturnType<typeof scanBooksResult>> | any[]} */
let books = [];
let rootHandle = null;
let isProcessing = false;

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function checkBrowserSupport() {
  if (!('showDirectoryPicker' in window)) {
    els.unsupportedGate.classList.remove('hidden');
    els.app.classList.add('hidden');
    return false;
  }
  return true;
}

function pillMarkup(status) {
  const config = {
    pending: { label: 'Pending', cls: 'status-pill--pending' },
    processing: { label: 'Processing', cls: 'status-pill--processing' },
    checking: { label: 'Checking', cls: 'status-pill--processing' },
    done: { label: 'Done', cls: 'status-pill--done' },
    error: { label: 'Error', cls: 'status-pill--error' },
  }[status];
  return `<span class="status-pill ${config.cls}"><span class="dot"></span>${config.label}</span>`;
}

function applyMessageTone(element, book, message) {
  element.classList.remove(
    'text-danger',
    'text-success',
    'text-warn',
    'text-canvas-500',
    'dark:text-canvas-400'
  );
  if (book.error) {
    element.classList.add('text-danger');
  } else if (book.status === 'done' && message.startsWith('Verified')) {
    element.classList.add('text-success');
  } else if (/warning|below \d+ dpi|rebuild required|missing|multiple existing pdf/i.test(message)) {
    element.classList.add('text-warn');
  } else {
    element.classList.add('text-canvas-500', 'dark:text-canvas-400');
  }
}

function renderBookRow(book, index) {
  const node = els.rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.index = String(index);
  node.style.animationDelay = `${Math.min(index * 18, 240)}ms`;

  node.querySelector('.book-name').textContent = book.relativePath || book.name;
  node.querySelector('.book-pages').textContent = `${book.imageCount} pg`;
  node.querySelector('.status-pill-wrap').innerHTML = pillMarkup(book.status);

  const errorEl = node.querySelector('.book-error');
  const message = book.error || book.notice;
  if (message) {
    errorEl.classList.remove('hidden');
    errorEl.classList.add('flex');
    applyMessageTone(errorEl, book, message);
    errorEl.replaceChildren();
    const icon = document.createElement('i');
    icon.dataset.lucide = 'info';
    icon.className = 'h-3.5 w-3.5 shrink-0';
    const text = document.createElement('span');
    text.className = 'truncate';
    text.textContent = message;
    errorEl.append(icon, text);
  } else {
    errorEl.classList.add('hidden');
    errorEl.classList.remove('flex');
  }

  const rebuildBtn = node.querySelector('.rebuild-btn');
  if (book.status === 'done' || book.status === 'error') {
    rebuildBtn.classList.remove('hidden');
    rebuildBtn.addEventListener('click', () => processBooks([book]));
  }

  const checkPdfBtn = node.querySelector('.check-pdf-btn');
  if (book.pdfHandles?.length > 0) {
    checkPdfBtn.disabled = false;
    checkPdfBtn.title = 'Validate PDF';
    checkPdfBtn.classList.remove('cursor-not-allowed', 'opacity-60');
    checkPdfBtn.addEventListener('click', () => checkBookPdf(book));
  }

  const assetsBtn = node.querySelector('.tpt-assets-btn');
  assetsBtn.disabled = isProcessing;
  assetsBtn.addEventListener('click', () => createTptAssets(book));

  return node;
}

function renderBookList() {
  els.bookList.innerHTML = '';
  const frag = document.createDocumentFragment();
  books.forEach((book, index) => frag.appendChild(renderBookRow(book, index)));
  els.bookList.appendChild(frag);
  refreshIcons();
}

function renderSummary() {
  const pending = books.filter((b) => b.status === 'pending').length;
  const done = books.filter((b) => b.status === 'done').length;
  const errored = books.filter((b) => b.status === 'error').length;

  els.bookCount.textContent = String(books.length);
  els.pendingCount.textContent = String(pending);
  els.doneCount.textContent = String(done);
  els.errorCount.textContent = String(errored);
  els.errorCountWrap.classList.toggle('hidden', errored === 0);

  els.processAllBtn.disabled = isProcessing || pending === 0;
  els.redoAllBtn.disabled = isProcessing || books.length === 0;
  els.qualitySelect.disabled = isProcessing;
  els.pageFormatSelect.disabled = isProcessing;
  els.rescanBtn.disabled = isProcessing;
  els.chooseFolderBtn.disabled = isProcessing;
  els.emptyChooseFolderBtn.disabled = isProcessing;
}

function clearOperationMessage() {
  els.operationMessage.textContent = '';
  els.operationMessage.classList.add('hidden');
}

function showOperationError(error) {
  const detail = error?.message || 'Unexpected file operation failure.';
  els.operationMessage.textContent = `Bindery could not complete that action: ${detail}`;
  els.operationMessage.classList.remove('hidden');
}

async function runUiAction(action) {
  clearOperationMessage();
  try {
    await action();
  } catch (error) {
    console.error(error);
    showOperationError(error);
  }
}

function renderAll() {
  renderBookList();
  renderSummary();
}

function updateProgress(current, total) {
  if (total === 0) {
    els.progressWrap.classList.add('hidden');
    return;
  }
  els.progressWrap.classList.remove('hidden');
  els.progressCounter.textContent = `${current} / ${total}`;
  const pct = Math.round((current / total) * 100);
  els.progressBar.style.width = `${pct}%`;
}

async function loadFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw err;
  }

  rootHandle = handle;
  els.folderPath.classList.remove('hidden');
  els.folderPath.classList.add('flex');
  els.folderPathName.textContent = handle.name;

  await rescan();

  els.emptyState.classList.add('hidden');
  els.libraryView.classList.remove('hidden');
  els.libraryView.classList.add('flex');
}

async function rescan() {
  if (!rootHandle) return;
  books = await scanBooks(rootHandle);
  const results = await runPool(books, CONCURRENCY, validateScannedBook);
  results.forEach((result, index) => {
    if (!result.ok) {
      books[index].status = 'error';
      books[index].error = `PDF check failed: ${result.error?.message || 'unknown error'}`;
    }
  });
  renderAll();
}

function findPdfHandle(book, name) {
  return book.pdfHandles.find((entry) => entry.name.toLowerCase() === name?.toLowerCase());
}

async function validateScannedBook(book) {
  if (book.sourceChanged) {
    book.status = 'pending';
    book.notice = 'Source images changed since the last PDF. Rebuild required.';
    return;
  }
  const options = {
    expectedPageCount: book.imageCount,
    pageFormat: book.markerRecord?.pageFormat || null,
  };
  const owned = findPdfHandle(book, book.generatedPdfName);
  if (!owned && book.pdfHandles.length > 1) {
    book.status = 'pending';
    book.notice = 'Multiple existing PDFs were found and none is recorded as Bindery-owned. Rebuild to create a separate verified Bindery PDF.';
    return;
  }
  const candidates = owned ? [owned] : book.pdfHandles;
  let bestFailure = null;

  for (const candidate of candidates) {
    const result = await validatePdfHandle(candidate.handle, PDFLib, options);
    if (result.ok) {
      book.status = 'done';
      book.validatedPdfName = candidate.name;
      book.validation = result;
      book.notice = result.warnings[0] || `Verified ${result.pageCount}-page PDF.`;
      return;
    }
    bestFailure = result;
  }

  if (candidates.length > 0) {
    book.notice = bestFailure?.errors[0] || 'Existing PDF failed validation. Rebuild required.';
  } else if (book.markerRecord) {
    book.notice = 'The PDF recorded by Bindery is missing. Rebuild required.';
  }
  book.status = 'pending';
  book.validation = bestFailure;
}

async function checkBookPdf(book) {
  if (isProcessing) return;
  book.status = 'checking';
  book.error = null;
  book.notice = 'Checking PDF…';
  renderAll();
  await validateScannedBook(book);
  renderAll();
}

async function createTptAssets(book) {
  if (isProcessing) return;
  isProcessing = true;
  const previousStatus = book.status;
  book.notice = 'Creating preview and thumbnails…';
  book.error = null;
  renderAll();

  try {
    const pageFormat = els.pageFormatSelect.value;
    const compress = els.qualitySelect.value === 'compressed';
    const assetsDir = await book.dirHandle.getDirectoryHandle('_tpt_assets', { create: true });
    const previewHandles = book.imageHandles.slice(0, 3);
    const previewBytes = await buildBookPdf(previewHandles, PDFLib, {
      compress,
      pageFormat,
      title: `${book.name} — Preview`,
    });
    const previewName = `${book.name} - Preview.pdf`;
    const previewHandle = await assetsDir.getFileHandle(previewName, { create: true });
    const previewWritable = await previewHandle.createWritable();
    await previewWritable.write(previewBytes);
    await previewWritable.close();
    const previewValidation = await validatePdfHandle(previewHandle, PDFLib, {
      expectedPageCount: previewHandles.length,
      pageFormat,
    });
    if (!previewValidation.ok) throw new Error(previewValidation.errors.join(' '));

    const thumbnails = book.imageHandles.slice(0, 4);
    for (let index = 0; index < thumbnails.length; index++) {
      const source = await thumbnails[index].handle.getFile();
      const extension = thumbnails[index].name.split('.').pop().toLowerCase();
      const thumbnailHandle = await assetsDir.getFileHandle(
        `Thumbnail ${index + 1}.${extension}`,
        { create: true }
      );
      const writable = await thumbnailHandle.createWritable();
      await writable.write(source);
      await writable.close();
    }

    book.notice = `Created a ${previewHandles.length}-page preview and ${thumbnails.length} thumbnails in _tpt_assets.`;
    book.status = previousStatus;
  } catch (error) {
    book.status = previousStatus;
    book.error = `TPT asset creation failed: ${error?.message || 'unknown error'}`;
  } finally {
    isProcessing = false;
    renderAll();
  }
}

async function processOneBook(book, qualityMode, pageFormat) {
  const index = books.indexOf(book);
  book.status = 'processing';
  book.error = null;
  renderAll();

  try {
    const pdfName = chooseOutputPdfName(book);
    const pageDiagnostics = [];
    const pdfBytes = await buildBookPdf(book.imageHandles, PDFLib, {
      compress: qualityMode === 'compressed',
      pageFormat,
      title: book.name,
      onPageProcessed: (diagnostic) => pageDiagnostics.push(diagnostic),
    });

    const pdfFileHandle = await book.dirHandle.getFileHandle(pdfName, { create: true });
    const pdfWritable = await pdfFileHandle.createWritable();
    await pdfWritable.write(pdfBytes);
    await pdfWritable.close();

    const validation = await validatePdfHandle(pdfFileHandle, PDFLib, {
      expectedPageCount: book.imageCount,
      pageFormat,
    });
    if (!validation.ok) {
      throw new Error(`Written PDF failed verification: ${validation.errors.join(' ')}`);
    }

    const doneRecord = {
      processedAt: new Date().toISOString(),
      imageCount: book.imageCount,
      pdfFile: pdfName,
      quality: qualityMode,
      pageFormat,
      imageSnapshot: book.imageSnapshot,
      minimumDpi: pageDiagnostics.length
        ? Math.round(Math.min(...pageDiagnostics.map((page) => page.effectiveDpi)))
        : null,
      verifiedAt: new Date().toISOString(),
    };
    const doneFileHandle = await book.dirHandle.getFileHandle('.done', { create: true });
    const doneWritable = await doneFileHandle.createWritable();
    await doneWritable.write(JSON.stringify(doneRecord, null, 2));
    await doneWritable.close();

    book.generatedPdfName = pdfName;
    if (!book.pdfNames.some((name) => name.toLowerCase() === pdfName.toLowerCase())) {
      book.pdfNames.push(pdfName);
      book.pdfHandles.push({ name: pdfName, handle: pdfFileHandle });
    }
    book.markerRecord = doneRecord;
    book.sourceChanged = false;
    book.validation = validation;
    const lowResolutionPages = pageDiagnostics.filter((page) => page.effectiveDpi < 200);
    const printWarnings = pageDiagnostics.filter((page) => page.effectiveDpi >= 200 && page.effectiveDpi < 300);
    if (lowResolutionPages.length > 0) {
      const first = lowResolutionPages[0];
      book.notice = `Print warning: ${lowResolutionPages.length} page(s) are below 200 DPI; lowest is ${Math.round(first.effectiveDpi)} DPI (${first.name}).`;
    } else if (printWarnings.length > 0) {
      const minimum = Math.min(...printWarnings.map((page) => page.effectiveDpi));
      book.notice = `Print check recommended: ${printWarnings.length} page(s) are below 300 DPI; lowest is ${Math.round(minimum)} DPI.`;
    } else {
      book.notice = validation.warnings[0] || `Verified ${validation.pageCount}-page PDF at 300 DPI or better.`;
    }
    book.status = 'done';
  } catch (err) {
    console.error(`Failed to process "${book.name}":`, err);
    book.status = 'error';
    book.error = err && err.message ? err.message : 'Something went wrong while building this PDF.';
  }

  if (index !== -1) renderAll();
}

async function processBooks(targetBooks) {
  if (isProcessing || targetBooks.length === 0) return;
  isProcessing = true;
  renderSummary();

  let completed = 0;
  const total = targetBooks.length;
  const qualityMode = els.qualitySelect.value;
  const pageFormat = els.pageFormatSelect.value;
  updateProgress(0, total);

  await runPool(targetBooks, CONCURRENCY, async (book) => {
    await processOneBook(book, qualityMode, pageFormat);
    completed += 1;
    updateProgress(completed, total);
  });

  isProcessing = false;
  updateProgress(0, 0);
  renderAll();
}

function processAllPending() {
  const pending = books.filter((b) => b.status === 'pending');
  return processBooks(pending);
}

function redoAllBooks() {
  return processBooks([...books]);
}

els.chooseFolderBtn.addEventListener('click', () => runUiAction(loadFolder));
els.emptyChooseFolderBtn.addEventListener('click', () => runUiAction(loadFolder));
els.rescanBtn.addEventListener('click', () => runUiAction(rescan));
els.redoAllBtn.addEventListener('click', () => runUiAction(redoAllBooks));
els.processAllBtn.addEventListener('click', () => runUiAction(processAllPending));
if (checkBrowserSupport()) {
  refreshIcons();
}
