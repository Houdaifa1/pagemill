import { scanBooks } from './fs-scan.js?v=20260901-3';
import { buildBookPdf } from './pdf-builder.js?v=20260901-2';
import { runPool } from './pool.js?v=20260901-1';
import { chooseOutputPdfName } from './output-name.js?v=20260901-1';

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
  node.querySelector('.book-pages').textContent = `${book.imageCount} pg`;
  node.querySelector('.status-pill-wrap').innerHTML = pillMarkup(book.status);

  const errorEl = node.querySelector('.book-error');
  if (book.status === 'error' && book.error) {
    errorEl.classList.remove('hidden');
    errorEl.classList.add('flex');
    errorEl.innerHTML = `<i data-lucide="info" class="h-3.5 w-3.5 shrink-0"></i><span class="truncate">${book.error}</span>`;
  } else {
    errorEl.classList.add('hidden');
    errorEl.classList.remove('flex');
  }

  const rebuildBtn = node.querySelector('.rebuild-btn');
  if (book.status === 'done' || book.status === 'error') {
    rebuildBtn.classList.remove('hidden');
    rebuildBtn.addEventListener('click', () => processBooks([book]));
  }

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
  renderAll();
}

async function processOneBook(book, qualityMode) {
  const index = books.indexOf(book);
  book.status = 'processing';
  book.error = null;
  renderAll();

  try {
    const pdfName = chooseOutputPdfName(book);
    const pdfBytes = await buildBookPdf(book.imageHandles, PDFLib, {
      compress: qualityMode === 'compressed',
      title: book.name,
    });

    const pdfFileHandle = await book.dirHandle.getFileHandle(pdfName, { create: true });
    const pdfWritable = await pdfFileHandle.createWritable();
    await pdfWritable.write(pdfBytes);
    await pdfWritable.close();

    const doneRecord = {
      processedAt: new Date().toISOString(),
      imageCount: book.imageCount,
      pdfFile: pdfName,
      quality: qualityMode,
    };
    const doneFileHandle = await book.dirHandle.getFileHandle('.done', { create: true });
    const doneWritable = await doneFileHandle.createWritable();
    await doneWritable.write(JSON.stringify(doneRecord, null, 2));
    await doneWritable.close();

    book.generatedPdfName = pdfName;
    if (!book.pdfNames.some((name) => name.toLowerCase() === pdfName.toLowerCase())) {
      book.pdfNames.push(pdfName);
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
  updateProgress(0, total);

  await runPool(targetBooks, CONCURRENCY, async (book) => {
    await processOneBook(book, qualityMode);
    completed += 1;
    updateProgress(completed, total);
  });

  isProcessing = false;
  updateProgress(0, 0);
  renderAll();
}

function processAllPending() {
  const pending = books.filter((b) => b.status === 'pending');
  processBooks(pending);
}

function redoAllBooks() {
  processBooks([...books]);
}

els.chooseFolderBtn.addEventListener('click', loadFolder);
els.emptyChooseFolderBtn.addEventListener('click', loadFolder);
els.rescanBtn.addEventListener('click', rescan);
els.redoAllBtn.addEventListener('click', redoAllBooks);
els.processAllBtn.addEventListener('click', processAllPending);

if (checkBrowserSupport()) {
  refreshIcons();
}
