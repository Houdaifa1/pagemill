import { scanBooks } from './fs-scan.js?v=20260831-3';
import { buildBookPdf } from './pdf-builder.js?v=20260831-3';
import { runPool } from './pool.js?v=20260831-3';
import { chooseOutputPdfName } from './output-name.js?v=20260831-3';
import { validatePdfHandle } from './pdf-validator.js?v=20260831-3';

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

function renderBookRow(book, index) {
  const node = els.rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.index = String(index);
  node.style.animationDelay = `${Math.min(index * 18, 240)}ms`;
  node.querySelector('.book-name').textContent = book.relativePath || book.name;
  node.querySelector('.book-pages').textContent = `${book.pageCount} pg`;
  node.querySelector('.status-pill-wrap').innerHTML = pillMarkup(book.status);

  const messageEl = node.querySelector('.book-error');
  const message = book.error || book.notice;
  if (message) {
    messageEl.classList.remove('hidden');
    messageEl.classList.add('flex');
    messageEl.classList.toggle('text-danger', Boolean(book.error));
    messageEl.classList.toggle('text-success', !book.error && book.status === 'done');
    messageEl.replaceChildren();
    const icon = document.createElement('i');
    icon.dataset.lucide = 'info';
    icon.className = 'h-3.5 w-3.5 shrink-0';
    const text = document.createElement('span');
    text.className = 'truncate';
    text.textContent = message;
    messageEl.append(icon, text);
  }

  const rebuildBtn = node.querySelector('.rebuild-btn');
  if (book.status === 'done' || book.status === 'error') {
    rebuildBtn.classList.remove('hidden');
    rebuildBtn.addEventListener('click', () => processBooks([book]));
  }

  const checkPdfBtn = node.querySelector('.check-pdf-btn');
  if (book.pdfHandles.length > 0) {
    checkPdfBtn.disabled = false;
    checkPdfBtn.title = 'Fully validate PDF';
    checkPdfBtn.classList.remove('cursor-not-allowed', 'opacity-60');
    checkPdfBtn.addEventListener('click', () => checkBookPdf(book));
  }
  return node;
}

function renderAll() {
  els.bookList.innerHTML = '';
  const fragment = document.createDocumentFragment();
  books.forEach((book, index) => fragment.appendChild(renderBookRow(book, index)));
  els.bookList.appendChild(fragment);

  const pending = books.filter((book) => book.status === 'pending').length;
  const done = books.filter((book) => book.status === 'done').length;
  const errors = books.filter((book) => book.status === 'error').length;
  els.bookCount.textContent = String(books.length);
  els.pendingCount.textContent = String(pending);
  els.doneCount.textContent = String(done);
  els.errorCount.textContent = String(errors);
  els.errorCountWrap.classList.toggle('hidden', errors === 0);
  els.processAllBtn.disabled = isProcessing || pending === 0;
  els.redoAllBtn.disabled = isProcessing || books.length === 0;
  els.rescanBtn.disabled = isProcessing;
  els.chooseFolderBtn.disabled = isProcessing;
  els.emptyChooseFolderBtn.disabled = isProcessing;
  refreshIcons();
}

function updateProgress(current, total) {
  els.progressWrap.classList.toggle('hidden', total === 0);
  if (total === 0) return;
  els.progressCounter.textContent = `${current} / ${total}`;
  els.progressBar.style.width = `${Math.round((current / total) * 100)}%`;
}

function showOperationError(error) {
  els.operationMessage.textContent = `Bindery could not complete that action: ${error?.message || 'unexpected failure'}`;
  els.operationMessage.classList.remove('hidden');
}

async function runUiAction(action) {
  els.operationMessage.classList.add('hidden');
  try {
    await action();
  } catch (error) {
    console.error(error);
    showOperationError(error);
  }
}

async function loadFolder() {
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (error) {
    if (error.name === 'AbortError') return;
    throw error;
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
  renderAll();
}

function findPdfHandle(book, name) {
  return book.pdfHandles.find((entry) => entry.name.toLowerCase() === name?.toLowerCase());
}

async function checkBookPdf(book) {
  if (isProcessing) return;
  book.status = 'checking';
  book.error = null;
  book.notice = 'Fully checking PDF...';
  renderAll();
  try {
    const owned = findPdfHandle(book, book.generatedPdfName);
    const candidates = owned ? [owned] : book.pdfHandles;
    if (candidates.length !== 1) throw new Error('Select a folder with one PDF or rebuild it with Bindery.');
    const result = await validatePdfHandle(candidates[0].handle, PDFLib, {
      expectedPageCount: book.pageCount,
    });
    if (!result.ok) throw new Error(result.errors.join(' '));
    book.status = 'done';
    book.notice = `Verified ${result.pageCount} aligned US Letter pages.`;
  } catch (error) {
    book.status = 'error';
    book.error = `PDF check failed: ${error?.message || 'unknown error'}`;
  }
  renderAll();
}

async function processOneBook(book) {
  book.status = 'processing';
  book.error = null;
  book.notice = 'Building PDF...';
  renderAll();
  const startedAt = performance.now();

  try {
    const pdfName = chooseOutputPdfName(book);
    const pdfBytes = await buildBookPdf(book.imageHandles, PDFLib, { title: book.name });
    const pdfHandle = await book.dirHandle.getFileHandle(pdfName, { create: true });
    const writable = await pdfHandle.createWritable();
    await writable.write(pdfBytes);
    await writable.close();

    const writtenFile = await pdfHandle.getFile();
    if (writtenFile.size !== pdfBytes.length) {
      throw new Error(`Written PDF size mismatch (${writtenFile.size} instead of ${pdfBytes.length} bytes).`);
    }

    const doneRecord = {
      processedAt: new Date().toISOString(),
      pageCount: book.pageCount,
      imageCount: book.pageCount,
      pdfFile: pdfName,
      pdfSize: writtenFile.size,
      pageFormat: 'letter',
      sourceMode: 'png',
      sourceSnapshot: book.sourceSnapshot,
      imageSnapshot: book.sourceSnapshot,
    };
    const doneHandle = await book.dirHandle.getFileHandle('.done', { create: true });
    const doneWritable = await doneHandle.createWritable();
    await doneWritable.write(JSON.stringify(doneRecord, null, 2));
    await doneWritable.close();

    book.generatedPdfName = pdfName;
    book.markerRecord = doneRecord;
    book.sourceChanged = false;
    if (!book.pdfNames.some((name) => name.toLowerCase() === pdfName.toLowerCase())) {
      book.pdfNames.push(pdfName);
      book.pdfHandles.push({ name: pdfName, handle: pdfHandle });
    }
    const seconds = (performance.now() - startedAt) / 1000;
    book.status = 'done';
    book.notice = `Created ${book.pageCount} aligned US Letter pages in ${seconds.toFixed(2)} s.`;
  } catch (error) {
    console.error(`Failed to process ${book.name}:`, error);
    book.status = 'error';
    book.error = error?.message || 'PDF generation failed.';
  }
  renderAll();
}

async function processBooks(targetBooks) {
  if (isProcessing || targetBooks.length === 0) return;
  isProcessing = true;
  renderAll();
  let completed = 0;
  updateProgress(0, targetBooks.length);
  await runPool(targetBooks, CONCURRENCY, async (book) => {
    await processOneBook(book);
    completed += 1;
    updateProgress(completed, targetBooks.length);
  });
  isProcessing = false;
  updateProgress(0, 0);
  renderAll();
}

els.chooseFolderBtn.addEventListener('click', () => runUiAction(loadFolder));
els.emptyChooseFolderBtn.addEventListener('click', () => runUiAction(loadFolder));
els.rescanBtn.addEventListener('click', () => runUiAction(rescan));
els.redoAllBtn.addEventListener('click', () => runUiAction(() => processBooks([...books])));
els.processAllBtn.addEventListener('click', () => runUiAction(() => processBooks(books.filter((book) => book.status === 'pending'))));

if (checkBrowserSupport()) refreshIcons();
