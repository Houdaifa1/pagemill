import { scanBooks, DONE_FORMAT_VERSION } from './fs-scan.js?v=20261031-2';
import {
  buildBookPdf,
  DEFAULT_OCR_LANGUAGE,
  DEFAULT_SQUARE_COVER_COUNT,
} from './pdf-builder.js?v=20260902-2';
import { runPool } from './pool.js?v=20260901-1';
import { extractImagesFromArchives } from './archive-extractor.js?v=20260906-2';
import { prepareBookPages } from './book-pages.js?v=20260930-2';
import {
  OUTPUT_LAYOUT_FLAT,
  OUTPUT_LAYOUT_FOLDERS,
  resolveOutputDirectory,
  createOutputNameAllocator,
} from './output-location.js?v=20260930-1';
import { selectPreviewPageIndexes, buildPreviewPdf } from './preview.js?v=20260930-1';
import {
  ANSWER_KEYS_AUTO,
  ANSWER_KEYS_MANUAL,
  ANSWER_KEYS_NONE,
  answerKeySignature,
  appendAnswerKeys,
  ownedPdfNames,
  scanAnswerKeys,
} from './answer-keys.js?v=20261031-1';
import { naturalCompare } from './natural-sort.js?v=20260901-1';

// Two books at a time keeps memory stable when each book contains dozens of
// multi-megabyte scans. Higher concurrency can freeze or crash browser tabs.
const CONCURRENCY = 2;
const PDFLib = window.PDFLib;

// The OCR engine is imported only when searchable text is actually switched on,
// so the default image-only path never downloads or starts it.
let ocrModulePromise = null;
function loadOcrModule() {
  if (!ocrModulePromise) {
    ocrModulePromise = import('./ocr.js?v=20260902-3').catch((err) => {
      ocrModulePromise = null;
      throw err;
    });
  }
  return ocrModulePromise;
}

const els = {
  unsupportedGate: document.getElementById('unsupported-gate'),
  app: document.getElementById('app'),
  emptyState: document.getElementById('empty-state'),
  libraryView: document.getElementById('library-view'),
  chooseFolderBtn: document.getElementById('choose-folder-btn'),
  emptyChooseFolderBtn: document.getElementById('empty-choose-folder-btn'),
  extractArchivesBtn: document.getElementById('extract-archives-btn'),
  emptyExtractArchivesBtn: document.getElementById('empty-extract-archives-btn'),
  archiveStatus: document.getElementById('archive-status'),
  archiveStatusTitle: document.getElementById('archive-status-title'),
  archiveStatusDetail: document.getElementById('archive-status-detail'),
  rescanBtn: document.getElementById('rescan-btn'),
  redoAllBtn: document.getElementById('redo-all-btn'),
  processAllBtn: document.getElementById('process-all-btn'),
  settingsSummary: document.getElementById('settings-summary'),
  qualitySelect: document.getElementById('quality-select'),
  squareCoverCount: document.getElementById('square-cover-count'),
  coversAtEnd: document.getElementById('covers-at-end'),
  pageNumbersEnabled: document.getElementById('page-numbers-enabled'),
  searchableTextEnabled: document.getElementById('searchable-text-enabled'),
  chooseOutputBtn: document.getElementById('choose-output-btn'),
  chooseOutputLabel: document.getElementById('choose-output-label'),
  resetOutputBtn: document.getElementById('reset-output-btn'),
  outputLocation: document.getElementById('output-location'),
  outputLayoutOptions: document.getElementById('output-layout-options'),
  outputLayoutInputs: [...document.querySelectorAll('input[name="output-layout"]')],
  flatLayoutExample: document.getElementById('flat-layout-example'),
  foldersLayoutExample: document.getElementById('folders-layout-example'),
  outputExampleNote: document.getElementById('output-example-note'),
  previewEnabled: document.getElementById('preview-enabled'),
  previewOptions: document.getElementById('preview-options'),
  previewCountMode: document.getElementById('preview-count-mode'),
  previewPageCount: document.getElementById('preview-page-count'),
  excludeFirstPages: document.getElementById('exclude-first-pages'),
  excludePagesOptions: document.getElementById('exclude-pages-options'),
  excludedPageCount: document.getElementById('excluded-page-count'),
  firstIncludedPage: document.getElementById('first-included-page'),
  answerKeyModeInputs: [...document.querySelectorAll('input[name="answer-key-mode"]')],
  answerKeyStatusWrap: document.getElementById('answer-key-status-wrap'),
  answerKeyStatus: document.getElementById('answer-key-status'),
  answerKeyUnmatched: document.getElementById('answer-key-unmatched'),
  useFoundKeysBtn: document.getElementById('use-found-keys-btn'),
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
  progressDetail: document.getElementById('progress-detail'),
  rowTemplate: document.getElementById('book-row-template'),
};

/** @type {Array<ReturnType<typeof scanBooksResult>> | any[]} */
let books = [];
let rootHandle = null;
let customOutputHandle = null;
let isProcessing = false;
let isExtracting = false;
let isFindingAnswerKeys = false;
let coverSettingsBeforeSkip = null;
let unmatchedAnswerKeys = [];

function readSquareCoverCount() {
  const parsed = Number.parseInt(els.squareCoverCount.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SQUARE_COVER_COUNT;
}

function normalizeSquareCoverCount() {
  const count = readSquareCoverCount();
  els.squareCoverCount.value = String(count);
  return count;
}

function syncCoverSettingsWithSkip() {
  if (els.excludeFirstPages.checked) {
    coverSettingsBeforeSkip ||= {
      coversAtEnd: els.coversAtEnd.checked,
      squareCoverCount: normalizeSquareCoverCount(),
    };
    els.coversAtEnd.checked = false;
    els.squareCoverCount.value = '0';
  } else if (coverSettingsBeforeSkip) {
    els.coversAtEnd.checked = coverSettingsBeforeSkip.coversAtEnd;
    els.squareCoverCount.value = String(coverSettingsBeforeSkip.squareCoverCount);
    coverSettingsBeforeSkip = null;
  }
}

function normalizePreviewPageCount() {
  const parsed = Number.parseInt(els.previewPageCount.value, 10);
  const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 3;
  els.previewPageCount.value = String(count);
  return count;
}

function normalizeExcludedPageCount() {
  const parsed = Number.parseInt(els.excludedPageCount.value, 10);
  const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
  els.excludedPageCount.value = String(count);
  return count;
}

function currentOutputLayout() {
  return els.outputLayoutInputs.find((input) => input.checked)?.value || OUTPUT_LAYOUT_FLAT;
}

function currentAnswerKeyMode() {
  return els.answerKeyModeInputs.find((input) => input.checked)?.value || ANSWER_KEYS_NONE;
}

function setAnswerKeyMode(mode) {
  els.answerKeyModeInputs.forEach((input) => { input.checked = input.value === mode; });
}

function activeAnswerKeys(book, mode = currentAnswerKeyMode()) {
  if (mode === ANSWER_KEYS_AUTO) return book.answerKeyCandidates || [];
  if (mode === ANSWER_KEYS_MANUAL) return book.answerKeySelection || [];
  return [];
}

function sessionOutputFor(book, handle, layout) {
  return book.sessionOutputs?.find((output) =>
    output.rootHandle === handle && output.layout === layout
  ) || null;
}

function appendOutputExample(container, layout) {
  container.replaceChildren();
  if (!customOutputHandle) return;
  const root = document.createElement('span');
  root.className = 'block font-semibold text-canvas-700 dark:text-canvas-200';
  root.textContent = `📁 ${customOutputHandle.name}/`;
  container.appendChild(root);

  if (books.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'mt-1 block';
    empty.textContent = 'No books found in the selected folder.';
    container.appendChild(empty);
    return;
  }

  const usedFlatNames = new Map();
  for (const book of books.slice(0, 2)) {
    const count = (usedFlatNames.get(book.name.toLowerCase()) || 0) + 1;
    usedFlatNames.set(book.name.toLowerCase(), count);
    const baseName = layout === OUTPUT_LAYOUT_FLAT && count > 1
      ? `${book.name} - ${count}`
      : book.name;
    const entry = document.createElement('span');
    entry.className = 'mt-2 block border-l-2 border-canvas-300 dark:border-canvas-700 pl-2';
    if (layout === OUTPUT_LAYOUT_FOLDERS) {
      const folder = document.createElement('span');
      folder.className = 'block text-canvas-500 dark:text-canvas-400';
      folder.textContent = `📁 ${book.outputPathParts.join(' / ')}/`;
      entry.appendChild(folder);
    }
    const full = document.createElement('span');
    full.className = 'block';
    full.textContent = `📄 ${baseName}.pdf`;
    entry.appendChild(full);
    if (els.previewEnabled.checked) {
      const preview = document.createElement('span');
      preview.className = 'block';
      preview.textContent = `📄 ${baseName} - Preview.pdf`;
      entry.appendChild(preview);
    }
    container.appendChild(entry);
  }
}

function renderOutputSettings() {
  els.outputLocation.textContent = customOutputHandle
    ? `Output folder: ${customOutputHandle.name}`
    : "Beside each book's images, as usual.";
  els.chooseOutputLabel.textContent = customOutputHandle ? 'Change output folder' : 'Choose output folder';
  els.resetOutputBtn.classList.toggle('hidden', !customOutputHandle);
  els.outputLayoutOptions.classList.toggle('hidden', !customOutputHandle);
  if (customOutputHandle) {
    appendOutputExample(els.flatLayoutExample, OUTPUT_LAYOUT_FLAT);
    appendOutputExample(els.foldersLayoutExample, OUTPUT_LAYOUT_FOLDERS);
    const remaining = Math.max(0, books.length - 2);
    els.outputExampleNote.textContent = remaining
      ? `+ ${remaining} more book${remaining === 1 ? '' : 's'}. Existing PDF names get a safe suffix.`
      : 'Examples use your book folders. Existing PDF names get a safe suffix.';
  }
  els.previewOptions.classList.toggle('hidden', !els.previewEnabled.checked);
  els.previewOptions.classList.toggle('flex', els.previewEnabled.checked);
  els.previewPageCount.classList.toggle('hidden', els.previewCountMode.value !== 'manual');
  els.excludePagesOptions.classList.toggle('hidden', !els.excludeFirstPages.checked);
  els.excludePagesOptions.classList.toggle('flex', els.excludeFirstPages.checked);
  const excludedCount = normalizeExcludedPageCount();
  els.firstIncludedPage.textContent = String(excludedCount + 1);
}

function updateSettingsSummary() {
  const parts = [els.qualitySelect.value === 'original' ? 'Original quality' : 'Compressed'];
  if (!els.excludeFirstPages.checked) {
    parts.push(`${readSquareCoverCount()} covers`, els.coversAtEnd.checked ? 'covers at end' : 'folder order');
  }
  if (els.pageNumbersEnabled.checked) parts.push('page numbers');
  if (els.searchableTextEnabled.checked) parts.push('OCR');
  if (els.excludeFirstPages.checked) parts.push(`skip ${normalizeExcludedPageCount()} pages`);
  els.settingsSummary.textContent = parts.join(' · ');
}

function applyCurrentSettingsToBooks() {
  const excludeFirstPages = els.excludeFirstPages.checked;
  const squareCoverCount = excludeFirstPages ? 0 : readSquareCoverCount();
  const quality = els.qualitySelect.value;
  const pageNumbersEnabled = els.pageNumbersEnabled.checked;
  const searchableTextEnabled = els.searchableTextEnabled.checked;
  const coversAtEnd = excludeFirstPages ? false : els.coversAtEnd.checked;
  const previewEnabled = els.previewEnabled.checked;
  const previewMode = els.previewCountMode.value;
  const previewManualCount = normalizePreviewPageCount();
  const outputLayout = currentOutputLayout();
  const excludedPageCount = normalizeExcludedPageCount();
  const answerKeyMode = currentAnswerKeyMode();

  books.forEach((book) => {
    const marker = book.markerRecord;
    const keySignature = answerKeySignature(activeAnswerKeys(book, answerKeyMode));
    if (book.status === 'processing') return;
    const hadError = book.status === 'error';
    if (hadError) book.error = null;
    if (!marker) {
      // Only a .done marker proves a book was built. A PDF beside the images may
      // be an answer key, so it is protected by name but doesn't finish the book.
      book.status = 'pending';
      book.notice = null;
      return;
    }
    if (Number(marker.formatVersion) < DONE_FORMAT_VERSION) {
      book.status = 'pending';
      book.notice = null;
      return;
    }

    const outputMatches = customOutputHandle
      ? marker.outputMode === 'custom' &&
        (marker.outputLayout || OUTPUT_LAYOUT_FOLDERS) === outputLayout &&
        Boolean(sessionOutputFor(book, customOutputHandle, outputLayout))
      : (marker.outputMode || 'source') === 'source';
    const previewMatches = Boolean(marker.previewEnabled) === previewEnabled &&
      (!previewEnabled || (
        marker.previewWatermarkVersion === 1 &&
        (marker.previewMode || 'auto') === previewMode &&
        (previewMode !== 'manual' || marker.previewManualCount === previewManualCount)
      ));

    const keysMatch = (marker.answerKeySignature || '') === keySignature;
    const matches = keysMatch &&
      marker.imageCount === book.imageCount &&
      marker.squareCoverCount === squareCoverCount &&
      marker.coversAtEnd === coversAtEnd &&
      marker.pageNumbersEnabled === pageNumbersEnabled &&
      marker.searchableTextEnabled === searchableTextEnabled &&
      marker.quality === quality &&
      Boolean(marker.excludeFirstPages) === excludeFirstPages &&
      (!excludeFirstPages || marker.excludedPageCount === excludedPageCount) &&
      outputMatches && previewMatches;
    book.status = matches ? 'done' : 'pending';
    book.notice = null;
  });
}

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

function answerKeyActionButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'answer-key-name truncate rounded border border-canvas-200 dark:border-canvas-700 px-1.5 py-0.5 font-medium text-canvas-700 dark:text-canvas-200 hover:bg-canvas-100 dark:hover:bg-canvas-800 disabled:cursor-not-allowed disabled:opacity-40';
  button.textContent = label;
  button.title = label;
  button.disabled = isProcessing || isExtracting || isFindingAnswerKeys;
  button.addEventListener('click', onClick);
  return button;
}

function renderBookRow(book, index) {
  const node = els.rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.index = String(index);
  node.style.animationDelay = `${Math.min(index * 18, 240)}ms`;

  node.querySelector('.book-name').textContent = book.relativePath || book.name;
  node.querySelector('.book-pages').textContent = `${book.imageCount} pg`;
  node.querySelector('.status-pill-wrap').innerHTML = pillMarkup(book.status);

  const errorEl = node.querySelector('.book-error');
  const message = book.status === 'error' ? book.error : book.notice;
  if (message) {
    errorEl.classList.remove('hidden');
    errorEl.classList.add('flex');
    errorEl.classList.toggle('text-danger', book.status === 'error');
    errorEl.classList.toggle('text-warn', book.status !== 'error');
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

  renderBookAnswerKeys(node.querySelector('.book-key'), book);

  const rebuildBtn = node.querySelector('.rebuild-btn');
  if (book.status === 'done' || book.status === 'error') {
    rebuildBtn.classList.remove('hidden');
    rebuildBtn.addEventListener('click', () => processBooks([book]));
  }

  return node;
}

function renderBookAnswerKeys(container, book) {
  const mode = currentAnswerKeyMode();
  container.classList.toggle('hidden', mode === ANSWER_KEYS_NONE);
  container.classList.toggle('flex', mode !== ANSWER_KEYS_NONE);
  if (mode === ANSWER_KEYS_NONE) return;

  const keys = activeAnswerKeys(book, mode);
  const icon = document.createElement('i');
  icon.dataset.lucide = 'key-round';
  icon.className = `h-3.5 w-3.5 shrink-0 ${keys.length > 0 ? 'text-accent-500' : ''}`;
  container.appendChild(icon);

  const label = document.createElement('span');
  label.className = 'answer-key-name truncate';
  if (keys.length > 0) {
    label.textContent = keys.map((key) => key.name).join(', ');
    label.title = keys.map((key) => key.path).join('\n');
    label.classList.add('text-canvas-700', 'dark:text-canvas-200');
  } else {
    label.textContent = mode === ANSWER_KEYS_AUTO ? 'No answer key found' : 'No answer key';
  }
  container.appendChild(label);

  if (mode === ANSWER_KEYS_MANUAL) {
    const found = book.answerKeyCandidates || [];
    if (keys.length === 0 && found.length > 0) {
      const foundLabel = found.length === 1 ? `Use ${found[0].name}` : `Use ${found.length} found PDFs`;
      container.appendChild(answerKeyActionButton(foundLabel, () => selectAnswerKeys(book, found)));
    }
    container.appendChild(answerKeyActionButton(
      keys.length > 0 ? 'Change' : 'Choose PDF',
      () => chooseAnswerKeys(book)
    ));
    if (keys.length > 0) {
      container.appendChild(answerKeyActionButton('Remove', () => selectAnswerKeys(book, [])));
    }
  }

  if (book.answerKeyWarning) {
    const warning = document.createElement('span');
    warning.className = 'basis-full text-warn-700 dark:text-warn';
    warning.textContent = book.answerKeyWarning;
    container.appendChild(warning);
  }
}

function renderAnswerKeySettings() {
  const mode = currentAnswerKeyMode();
  const isBusy = isProcessing || isExtracting || isFindingAnswerKeys;
  els.answerKeyModeInputs.forEach((input) => { input.disabled = isBusy; });
  els.answerKeyStatusWrap.classList.toggle('hidden', mode === ANSWER_KEYS_NONE);
  els.answerKeyStatusWrap.classList.toggle('flex', mode !== ANSWER_KEYS_NONE);

  const withKeys = books.filter((book) => activeAnswerKeys(book, mode).length > 0).length;
  const totalBooks = `${books.length} book${books.length === 1 ? '' : 's'}`;
  if (isFindingAnswerKeys) {
    els.answerKeyStatus.textContent = 'Looking for PDFs in every folder…';
  } else if (mode === ANSWER_KEYS_AUTO) {
    els.answerKeyStatus.textContent = withKeys > 0
      ? `Found answer keys for ${withKeys} of ${totalBooks}. Check the names in the book list.`
      : `No answer key PDFs found for these ${totalBooks}.`;
  } else if (mode === ANSWER_KEYS_MANUAL) {
    els.answerKeyStatus.textContent = `${withKeys} of ${totalBooks} ${withKeys === 1 ? 'has' : 'have'} an answer key. Books without one are built from images only.`;
  }

  const unmatched = mode === ANSWER_KEYS_NONE || isFindingAnswerKeys ? [] : unmatchedAnswerKeys;
  els.answerKeyUnmatched.classList.toggle('hidden', unmatched.length === 0);
  if (unmatched.length > 0) {
    const shown = unmatched.slice(0, 2).map((key) => key.path).join(', ');
    const more = unmatched.length > 2 ? ` and ${unmatched.length - 2} more` : '';
    els.answerKeyUnmatched.textContent = `Not added, because the book isn't clear: ${shown}${more}. Use Choose for each book to assign ${unmatched.length === 1 ? 'it' : 'them'}.`;
  }

  const unassigned = mode === ANSWER_KEYS_MANUAL
    ? books.filter((book) => !book.answerKeySelection?.length && book.answerKeyCandidates?.length)
    : [];
  els.useFoundKeysBtn.classList.toggle('hidden', unassigned.length === 0);
  els.useFoundKeysBtn.disabled = isBusy;
  els.useFoundKeysBtn.textContent = `Use found PDFs for ${unassigned.length} book${unassigned.length === 1 ? '' : 's'}`;
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

  const isBusy = isProcessing || isExtracting || isFindingAnswerKeys;
  els.processAllBtn.disabled = isBusy || pending === 0;
  els.redoAllBtn.disabled = isBusy || books.length === 0;
  els.rescanBtn.disabled = isBusy;
  els.qualitySelect.disabled = isBusy;
  els.squareCoverCount.disabled = isBusy || els.excludeFirstPages.checked;
  els.coversAtEnd.disabled = isBusy || els.excludeFirstPages.checked;
  els.pageNumbersEnabled.disabled = isBusy;
  els.searchableTextEnabled.disabled = isBusy;
  els.chooseFolderBtn.disabled = isBusy;
  els.emptyChooseFolderBtn.disabled = isBusy;
  els.extractArchivesBtn.disabled = isBusy;
  els.emptyExtractArchivesBtn.disabled = isBusy;
  els.chooseOutputBtn.disabled = isBusy;
  els.resetOutputBtn.disabled = isBusy;
  els.outputLayoutInputs.forEach((input) => { input.disabled = isBusy; });
  els.previewEnabled.disabled = isBusy;
  els.previewCountMode.disabled = isBusy;
  els.previewPageCount.disabled = isBusy;
  els.excludeFirstPages.disabled = isBusy;
  els.excludedPageCount.disabled = isBusy;
  renderOutputSettings();
  renderAnswerKeySettings();
  updateSettingsSummary();
}

function renderAll() {
  renderBookList();
  renderSummary();
}

function updateProgress(current, total) {
  if (total === 0) {
    els.progressWrap.classList.add('hidden');
    setProgressDetail('');
    return;
  }
  els.progressWrap.classList.remove('hidden');
  els.progressCounter.textContent = `${current} / ${total}`;
  const pct = Math.round((current / total) * 100);
  els.progressBar.style.width = `${pct}%`;
}

// A book can spend minutes inside OCR. Reporting the book, the phase, and the
// page keeps the tab from looking frozen while nothing else changes on screen.
function setProgressDetail(message) {
  els.progressDetail.textContent = message;
  els.progressDetail.classList.toggle('hidden', !message);
}

async function loadFolder() {
  if (isProcessing || isExtracting) return;
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw err;
  }

  rootHandle = handle;
  customOutputHandle = null;
  els.outputLayoutInputs.find((input) => input.value === OUTPUT_LAYOUT_FLAT).checked = true;
  books = [];
  setAnswerKeyMode(ANSWER_KEYS_NONE);
  els.folderPath.classList.remove('hidden');
  els.folderPath.classList.add('flex');
  els.folderPathName.textContent = handle.name;

  await rescan({ restoreAnswerKeyMode: true });

  els.emptyState.classList.add('hidden');
  els.libraryView.classList.remove('hidden');
  els.libraryView.classList.add('flex');
}

function showSelectedFolder(handle) {
  rootHandle = handle;
  els.folderPath.classList.remove('hidden');
  els.folderPath.classList.add('flex');
  els.folderPathName.textContent = handle.name;
}

function showLibrary() {
  els.emptyState.classList.add('hidden');
  els.libraryView.classList.remove('hidden');
  els.libraryView.classList.add('flex');
}

function setArchiveStatus(title, detail = '') {
  els.archiveStatus.classList.remove('hidden');
  els.archiveStatus.classList.add('flex');
  els.archiveStatusTitle.textContent = title;
  els.archiveStatusDetail.textContent = detail;
  refreshIcons();
}

// Extractor errors already begin with the archive's filename, and the failure
// record carries its full folder path. Printing both verbatim would repeat the
// name ("corrupt.zip: corrupt.zip: ..."), so drop the redundant prefix.
function describeArchiveFailure(failure) {
  const fileName = failure.archive.split(' / ').pop();
  const detail = failure.error.startsWith(`${fileName}: `)
    ? failure.error.slice(fileName.length + 2)
    : failure.error;
  return `${failure.archive}: ${detail}`;
}

async function extractArchives() {
  if (isProcessing || isExtracting) return;

  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw err;
  }

  showSelectedFolder(handle);
  customOutputHandle = null;
  els.outputLayoutInputs.find((input) => input.value === OUTPUT_LAYOUT_FLAT).checked = true;
  books = [];
  setAnswerKeyMode(ANSWER_KEYS_NONE);
  isExtracting = true;
  renderSummary();
  setArchiveStatus('Scanning for archives…', 'Checking this folder and every folder inside it.');

  try {
    const result = await extractImagesFromArchives(handle, {
      onProgress: ({ phase, archive, archivesFound, archivesProcessed, imagesWritten }) => {
        if (phase === 'extract') {
          setArchiveStatus(
            `Extracting archive ${archivesProcessed + 1} of ${archivesFound}…`,
            `${archive} · ${imagesWritten} image${imagesWritten === 1 ? '' : 's'} copied so far`
          );
        }
      },
    });

    rootHandle = handle;
    await rescan({ restoreAnswerKeyMode: true });
    showLibrary();

    if (result.archivesFound === 0) {
      setArchiveStatus(
        'No supported archives found',
        'Bindery looked in every folder for ZIP, TAR, TAR.GZ, TGZ, and image GZ files. Nothing was changed.'
      );
    } else if (result.failures.length > 0) {
      const succeeded = result.archivesFound - result.failures.length;
      // Every failure goes to the console so a folder with several bad
      // archives can be inspected in full; the status line shows the first.
      result.failures.forEach((failure) => {
        console.warn(`Archive skipped — ${describeArchiveFailure(failure)}`);
      });
      const remaining = result.failures.length - 1;
      setArchiveStatus(
        `Finished with ${result.failures.length} archive error${result.failures.length === 1 ? '' : 's'}`,
        `${result.imagesWritten} image${result.imagesWritten === 1 ? '' : 's'} extracted from ${succeeded} archive${succeeded === 1 ? '' : 's'}. ${describeArchiveFailure(result.failures[0])}${remaining > 0 ? ` (+${remaining} more in the console)` : ''}`
      );
    } else {
      setArchiveStatus(
        'Archive extraction complete',
        `${result.imagesWritten} new image${result.imagesWritten === 1 ? '' : 's'} extracted from ${result.archivesFound} archive${result.archivesFound === 1 ? '' : 's'}; ${result.imagesAlreadyPresent} identical image${result.imagesAlreadyPresent === 1 ? '' : 's'} already present. Ready for normal PDF creation.`
      );
    }
  } catch (err) {
    console.error('Archive extraction failed:', err);
    setArchiveStatus('Archive extraction failed', err.message || String(err));
  } finally {
    isExtracting = false;
    renderAll();
  }
}

async function rescan({ restoreAnswerKeyMode = false } = {}) {
  if (!rootHandle) return;
  const previous = new Map(books.map((book) => [book.relativePath, book]));
  books = await scanBooks(rootHandle);
  books.forEach((book) => {
    const earlier = previous.get(book.relativePath);
    book.sessionOutputs = earlier?.sessionOutputs || [];
    book.answerKeySelection = earlier?.answerKeySelection;
  });
  if (restoreAnswerKeyMode) {
    // Reopening a finished library keeps its keys instead of asking for rebuilds.
    const built = books.find((book) => book.markerRecord?.answerKeySignature);
    if (built) setAnswerKeyMode(built.markerRecord.answerKeyMode);
  }
  await refreshAnswerKeys();
  applyCurrentSettingsToBooks();
  renderAll();
}

// With keys off this does no extra folder reading at all.
async function refreshAnswerKeys() {
  const mode = currentAnswerKeyMode();
  unmatchedAnswerKeys = [];
  books.forEach((book) => {
    book.answerKeyCandidates = [];
    book.answerKeyWarning = null;
  });
  if (mode === ANSWER_KEYS_NONE || !rootHandle) return;

  const outputFolderNames = books.map((book) => book.markerRecord?.outputRootName).filter(Boolean);
  if (customOutputHandle) outputFolderNames.push(customOutputHandle.name);
  const scan = await scanAnswerKeys(rootHandle, books, { outputFolderNames });
  unmatchedAnswerKeys = scan.unmatched;
  for (const book of books) {
    book.answerKeyCandidates = scan.candidatesByBook.get(book) || [];
    if (mode === ANSWER_KEYS_MANUAL) await refreshManualSelection(book, scan.byPath);
  }
}

async function refreshManualSelection(book, pdfsByPath) {
  const marker = book.markerRecord;
  const missing = [];
  let selection = book.answerKeySelection;
  if (!selection && marker?.answerKeyMode === ANSWER_KEYS_MANUAL && Array.isArray(marker.answerKeys)) {
    // File picks do not survive a page reload, so saved picks are found again by path.
    selection = [];
    for (const saved of marker.answerKeys) {
      const key = pdfsByPath.get(saved.path);
      if (key) selection.push(key);
      else missing.push(saved.name);
    }
  } else if (selection) {
    const current = [];
    for (const key of selection) {
      try {
        const file = await key.handle.getFile();
        current.push({ ...key, size: file.size, lastModified: file.lastModified });
      } catch {
        missing.push(key.name);
      }
    }
    selection = current;
  }
  book.answerKeySelection = selection || [];
  if (missing.length > 0) {
    book.answerKeyWarning = `Can't find ${missing.join(', ')} any more. Choose ${missing.length === 1 ? 'it' : 'them'} again before rebuilding.`;
  }
}

async function changeAnswerKeyMode() {
  isFindingAnswerKeys = true;
  renderAll();
  try {
    await refreshAnswerKeys();
  } catch (err) {
    console.error('Could not look for answer keys:', err);
    setAnswerKeyMode(ANSWER_KEYS_NONE);
    setArchiveStatus('Could not look for answer keys', err.message || String(err));
  } finally {
    isFindingAnswerKeys = false;
    applyCurrentSettingsToBooks();
    renderAll();
  }
}

function selectAnswerKeys(book, keys) {
  if (isProcessing || isExtracting || isFindingAnswerKeys) return;
  book.answerKeySelection = keys;
  book.answerKeyWarning = null;
  applyCurrentSettingsToBooks();
  renderAll();
}

// A book's own result can't be its answer key: it would repeat every page, and
// the next rebuild would overwrite the file it was reading from.
async function isBookOutput(book, handle) {
  const inBookFolder = await book.dirHandle.resolve?.(handle);
  if (inBookFolder?.length === 1 && ownedPdfNames(book).has(handle.name.toLowerCase())) return true;
  for (const output of book.sessionOutputs || []) {
    if ([output.pdfName, output.previewName].includes(handle.name)
      && await output.rootHandle.resolve?.(handle)) return true;
  }
  return false;
}

async function chooseAnswerKeys(book) {
  if (isProcessing || isExtracting || isFindingAnswerKeys) return;
  let handles;
  try {
    handles = await window.showOpenFilePicker({
      multiple: true,
      startIn: book.dirHandle,
      types: [{ description: 'PDF files', accept: { 'application/pdf': ['.pdf'] } }],
    });
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Could not open the file picker:', err);
    book.answerKeyWarning = `Could not open the file picker: ${err.message || err}`;
    renderAll();
    return;
  }

  const keys = [];
  const rejected = [];
  for (const handle of handles) {
    if (!/\.pdf$/i.test(handle.name) || await isBookOutput(book, handle)) {
      rejected.push(handle.name);
      continue;
    }
    const file = await handle.getFile();
    const parts = await rootHandle.resolve?.(handle);
    keys.push({
      name: handle.name,
      handle,
      // A file outside the library keeps a label, and can't be found again after a reload.
      path: parts ? parts.join('/') : `outside library/${handle.name}`,
      size: file.size,
      lastModified: file.lastModified,
    });
  }
  keys.sort((a, b) => naturalCompare(a.path, b.path));

  if (keys.length > 0) book.answerKeySelection = keys;
  book.answerKeyWarning = rejected.length > 0
    ? `Not added: ${rejected.join(', ')}. Choose a PDF that isn't this book's own output.`
    : null;
  applyCurrentSettingsToBooks();
  renderAll();
}

async function chooseOutputFolder() {
  if (isProcessing || isExtracting) return;
  let selected;
  try {
    selected = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw err;
  }
  const knownHandles = new Set([
    customOutputHandle,
    ...books.flatMap((book) => (book.sessionOutputs || []).map((item) => item.rootHandle)),
  ]);
  for (const known of knownHandles) {
    if (known && typeof selected.isSameEntry === 'function' && await selected.isSameEntry(known)) {
      selected = known;
      break;
    }
  }
  customOutputHandle = selected;
  applyCurrentSettingsToBooks();
  renderAll();
}

function useImageFolders() {
  customOutputHandle = null;
  applyCurrentSettingsToBooks();
  renderAll();
}

async function writePdf(directory, name, bytes) {
  const fileHandle = await directory.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function processOneBook(book, settings) {
  const {
    qualityMode, squareCoverCount, coversAtEnd, pageNumbersEnabled,
    searchableTextEnabled, recognizeWords, ocrConcurrency,
    outputHandle, outputLayout, previewEnabled, previewMode, previewManualCount,
    excludeFirstPages, excludedPageCount, reserveOutputNames, answerKeyMode,
  } = settings;
  const index = books.indexOf(book);
  book.status = 'processing';
  book.error = null;
  book.notice = null;
  renderAll();

  try {
    setProgressDetail(`Building PDF — ${book.name}`);
    const { images, coverCount } = prepareBookPages(book.imageHandles, {
      coversAtEnd,
      squareCoverCount,
      excludeFirstPages,
      excludedPageCount,
    });
    const bookPdfBytes = await buildBookPdf(images, PDFLib, {
      compress: qualityMode === 'compressed',
      title: book.name,
      squareCoverCount: coverCount,
      pageNumbersEnabled,
      searchableText: searchableTextEnabled,
      recognizeWords,
      ocrConcurrency,
      onOcrProgress: ({ phase, completed, total }) => {
        setProgressDetail(
          phase === 'ocr'
            ? `Reading text — ${book.name}: ${completed} of ${total} pages`
            : `Assembling PDF — ${book.name}`
        );
      },
    });

    const previewIndexes = previewEnabled
      ? selectPreviewPageIndexes(
          images.length,
          coverCount,
          previewMode === 'manual' ? previewManualCount : null
        )
      : [];
    if (previewIndexes.length > 0) setProgressDetail(`Making preview — ${book.name}`);
    const previewBytes = await buildPreviewPdf(bookPdfBytes, previewIndexes, PDFLib);

    // Keys are added after the preview is cut, so previews can never show answers.
    // A bad key fails here, before any file is written.
    const answerKeys = activeAnswerKeys(book, answerKeyMode);
    let pdfBytes = bookPdfBytes;
    let answerKeyRecords = [];
    if (answerKeys.length > 0) {
      setProgressDetail(`Adding answer keys — ${book.name}`);
      const merged = await appendAnswerKeys(bookPdfBytes, answerKeys, PDFLib);
      pdfBytes = merged.bytes;
      answerKeyRecords = merged.records;
    }

    const outputDirectory = await resolveOutputDirectory(book, outputHandle, outputLayout);
    const ownedOutput = outputHandle
      ? sessionOutputFor(book, outputHandle, outputLayout)
      : ((book.markerRecord?.outputMode || 'source') === 'source'
          ? book.markerRecord
          : {
              pdfFile: book.markerRecord?.sourcePdfFile,
              previewFile: book.markerRecord?.sourcePreviewFile,
            });
    const key = outputHandle
      ? (outputLayout === OUTPUT_LAYOUT_FLAT
          ? 'flat'
          : `folders:${book.outputPathParts.join('\0')}`)
      : `source:${book.relativePath}`;
    const { pdfName, previewName } = await reserveOutputNames({
      book,
      directory: outputDirectory,
      key,
      layout: outputHandle ? outputLayout : OUTPUT_LAYOUT_FOLDERS,
      ownedOutput,
      previewEnabled: Boolean(previewBytes),
    });

    await writePdf(outputDirectory, pdfName, pdfBytes);
    if (previewBytes) await writePdf(outputDirectory, previewName, previewBytes);

    const doneRecord = {
      processedAt: new Date().toISOString(),
      imageCount: book.imageCount,
      pdfFile: pdfName,
      quality: qualityMode,
      squareCoverCount,
      coversAtEnd,
      pageNumbersEnabled,
      searchableTextEnabled,
      ocrLanguage: searchableTextEnabled ? DEFAULT_OCR_LANGUAGE : null,
      outputMode: outputHandle ? 'custom' : 'source',
      outputRootName: outputHandle?.name || null,
      outputLayout: outputHandle ? outputLayout : null,
      excludeFirstPages,
      excludedPageCount: excludeFirstPages ? excludedPageCount : null,
      sourcePdfFile: outputHandle
        ? ((book.markerRecord?.outputMode || 'source') === 'source'
            ? book.markerRecord?.pdfFile || null
            : book.markerRecord?.sourcePdfFile || null)
        : pdfName,
      sourcePreviewFile: outputHandle
        ? ((book.markerRecord?.outputMode || 'source') === 'source'
            ? book.markerRecord?.previewFile || null
            : book.markerRecord?.sourcePreviewFile || null)
        : previewName,
      previewEnabled,
      previewWatermarkVersion: previewEnabled ? 1 : null,
      previewMode: previewEnabled ? previewMode : null,
      previewManualCount: previewEnabled && previewMode === 'manual' ? previewManualCount : null,
      previewFile: previewName,
      answerKeyMode: answerKeyMode === ANSWER_KEYS_NONE ? null : answerKeyMode,
      answerKeys: answerKeyRecords,
      answerKeySignature: answerKeySignature(answerKeyRecords),
      ownedPdfFiles: [...new Set([
        ...(book.markerRecord?.ownedPdfFiles || []),
        ...(outputHandle ? [] : [pdfName, previewName].filter(Boolean)),
      ])],
      formatVersion: DONE_FORMAT_VERSION,
    };
    const doneFileHandle = await book.dirHandle.getFileHandle('.done', { create: true });
    const doneWritable = await doneFileHandle.createWritable();
    await doneWritable.write(JSON.stringify(doneRecord, null, 2));
    await doneWritable.close();

    if (!outputHandle) book.generatedPdfName = pdfName;
    book.markerRecord = doneRecord;
    if (outputHandle) {
      book.sessionOutputs ||= [];
      book.sessionOutputs = book.sessionOutputs.filter((item) =>
        item.rootHandle !== outputHandle || item.layout !== outputLayout
      );
      book.sessionOutputs.push({ rootHandle: outputHandle, layout: outputLayout, pdfName, previewName });
    }
    if (!outputHandle && !book.pdfNames.some((name) => name.toLowerCase() === pdfName.toLowerCase())) {
      book.pdfNames.push(pdfName);
    }
    if (!outputHandle && previewName && !book.pdfNames.some((name) => name.toLowerCase() === previewName.toLowerCase())) {
      book.pdfNames.push(previewName);
    }
    // Keep the sizes and dates just read, so the next scan sees these keys as unchanged.
    if (answerKeyMode === ANSWER_KEYS_MANUAL) {
      book.answerKeySelection = answerKeys.map((key, keyIndex) => ({ ...key, ...answerKeyRecords[keyIndex] }));
    } else if (answerKeyMode === ANSWER_KEYS_AUTO) {
      book.answerKeyCandidates = answerKeys.map((key, keyIndex) => ({ ...key, ...answerKeyRecords[keyIndex] }));
    }
    if (previewEnabled && previewIndexes.length === 0) {
      book.notice = 'No interior pages to use for a preview.';
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
  if (isProcessing || isFindingAnswerKeys || targetBooks.length === 0) return;
  isProcessing = true;
  renderSummary();

  let completed = 0;
  const total = targetBooks.length;
  const qualityMode = els.qualitySelect.value;
  const excludeFirstPages = els.excludeFirstPages.checked;
  const squareCoverCount = excludeFirstPages ? 0 : normalizeSquareCoverCount();
  const coversAtEnd = excludeFirstPages ? false : els.coversAtEnd.checked;
  const pageNumbersEnabled = els.pageNumbersEnabled.checked;
  const searchableTextEnabled = els.searchableTextEnabled.checked;
  const outputHandle = customOutputHandle;
  const outputLayout = currentOutputLayout();
  const previewEnabled = els.previewEnabled.checked;
  const previewMode = els.previewCountMode.value;
  const previewManualCount = normalizePreviewPageCount();
  const excludedPageCount = normalizeExcludedPageCount();
  const answerKeyMode = currentAnswerKeyMode();
  const reserveOutputNames = createOutputNameAllocator();
  updateProgress(0, total);

  let ocr = null;
  let recognizeWords = null;
  // Recognition is CPU-bound, so a few pages are read at once. The pool is
  // sized from the machine's cores and capped, keeping memory bounded.
  let ocrConcurrency = 1;
  if (searchableTextEnabled) {
    setProgressDetail('Starting the local OCR engine\u2026');
    try {
      ocr = await loadOcrModule();
      ocrConcurrency = ocr.recommendedOcrConcurrency();
      await ocr.configureOcrPool(ocrConcurrency);
      recognizeWords = (file) => ocr.recognizePageWords(file, { language: DEFAULT_OCR_LANGUAGE });
    } catch (err) {
      // Failing to start OCR must not silently produce non-searchable PDFs.
      console.error('Could not start the OCR engine:', err);
      targetBooks.forEach((book) => {
        book.status = 'error';
        book.error = `Searchable text is on but the OCR engine could not start: ${err.message || err}`;
      });
      isProcessing = false;
      updateProgress(0, 0);
      renderAll();
      return;
    }
  }

  try {
    await runPool(targetBooks, CONCURRENCY, async (book) => {
      await processOneBook(book, {
        qualityMode,
        squareCoverCount,
        coversAtEnd,
        pageNumbersEnabled,
        searchableTextEnabled,
        recognizeWords,
        ocrConcurrency,
        outputHandle,
        outputLayout,
        previewEnabled,
        previewMode,
        previewManualCount,
        excludeFirstPages,
        excludedPageCount,
        reserveOutputNames,
        answerKeyMode,
      });
      completed += 1;
      updateProgress(completed, total);
    });
  } finally {
    // The worker holds a wasm heap; release it as soon as the batch is over,
    // whether the batch succeeded, failed, or was interrupted.
    if (ocr) await ocr.terminateOcrWorker();
    isProcessing = false;
    updateProgress(0, 0);
    renderAll();
  }
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
els.extractArchivesBtn.addEventListener('click', extractArchives);
els.emptyExtractArchivesBtn.addEventListener('click', extractArchives);
els.rescanBtn.addEventListener('click', rescan);
els.redoAllBtn.addEventListener('click', redoAllBooks);
els.processAllBtn.addEventListener('click', processAllPending);
els.chooseOutputBtn.addEventListener('click', chooseOutputFolder);
els.resetOutputBtn.addEventListener('click', useImageFolders);
els.outputLayoutInputs.forEach((input) => input.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
}));
els.answerKeyModeInputs.forEach((input) => input.addEventListener('change', changeAnswerKeyMode));
els.useFoundKeysBtn.addEventListener('click', () => {
  if (isProcessing || isExtracting || isFindingAnswerKeys) return;
  books.forEach((book) => {
    if (!book.answerKeySelection?.length && book.answerKeyCandidates?.length) {
      book.answerKeySelection = book.answerKeyCandidates;
      book.answerKeyWarning = null;
    }
  });
  applyCurrentSettingsToBooks();
  renderAll();
});
els.previewEnabled.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});
els.previewCountMode.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});
els.previewPageCount.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});
els.excludeFirstPages.addEventListener('change', () => {
  syncCoverSettingsWithSkip();
  applyCurrentSettingsToBooks();
  renderAll();
});
els.excludedPageCount.addEventListener('input', () => {
  const parsed = Number.parseInt(els.excludedPageCount.value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    els.firstIncludedPage.textContent = String(parsed + 1);
  }
});
els.excludedPageCount.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});
els.squareCoverCount.addEventListener('change', normalizeSquareCoverCount);
els.squareCoverCount.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});
els.qualitySelect.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});
els.coversAtEnd.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});
els.pageNumbersEnabled.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});
els.searchableTextEnabled.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});

if (checkBrowserSupport()) {
  syncCoverSettingsWithSkip();
  normalizeSquareCoverCount();
  normalizePreviewPageCount();
  normalizeExcludedPageCount();
  renderOutputSettings();
  updateSettingsSummary();
  refreshIcons();
}
