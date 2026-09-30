import { scanBooks, DONE_FORMAT_VERSION } from './fs-scan.js?v=20260929-2';
import {
  buildBookPdf,
  DEFAULT_OCR_LANGUAGE,
  DEFAULT_SQUARE_COVER_COUNT,
} from './pdf-builder.js?v=20260902-2';
import { runPool } from './pool.js?v=20260901-1';
import { extractImagesFromArchives } from './archive-extractor.js?v=20260906-2';
import { prepareBookPages } from './book-pages.js?v=20260930-1';
import {
  OUTPUT_LAYOUT_FLAT,
  OUTPUT_LAYOUT_FOLDERS,
  resolveOutputDirectory,
  createOutputNameAllocator,
} from './output-location.js?v=20260930-1';
import { selectPreviewPageIndexes, buildPreviewPdf } from './preview.js?v=20260930-1';

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
  squareCoverCountHelp: document.getElementById('square-cover-count-help'),
  coversAtEnd: document.getElementById('covers-at-end'),
  pageNumbersEnabled: document.getElementById('page-numbers-enabled'),
  pageNumberHelp: document.getElementById('page-number-help'),
  searchableTextEnabled: document.getElementById('searchable-text-enabled'),
  searchableTextHelp: document.getElementById('searchable-text-help'),
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
  excludedPageCountVisual: document.getElementById('excluded-page-count-visual'),
  firstIncludedPage: document.getElementById('first-included-page'),
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

function readSquareCoverCount() {
  const parsed = Number.parseInt(els.squareCoverCount.value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SQUARE_COVER_COUNT;
}

function normalizeSquareCoverCount() {
  const count = readSquareCoverCount();
  els.squareCoverCount.value = String(count);
  els.squareCoverCountHelp.textContent = String(count);
  return count;
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
  els.excludedPageCountVisual.textContent = String(excludedCount);
  els.firstIncludedPage.textContent = String(excludedCount + 1);
}

function updateSettingsSummary() {
  const parts = [
    els.qualitySelect.value === 'original' ? 'Original quality' : 'Compressed',
    `${readSquareCoverCount()} covers`,
    els.coversAtEnd.checked ? 'covers at end' : 'folder order',
  ];
  if (els.pageNumbersEnabled.checked) parts.push('page numbers');
  if (els.searchableTextEnabled.checked) parts.push('OCR');
  if (els.excludeFirstPages.checked) parts.push(`skip ${normalizeExcludedPageCount()} pages`);
  els.settingsSummary.textContent = parts.join(' · ');
}

function applyCurrentSettingsToBooks() {
  const squareCoverCount = readSquareCoverCount();
  const quality = els.qualitySelect.value;
  const pageNumbersEnabled = els.pageNumbersEnabled.checked;
  const searchableTextEnabled = els.searchableTextEnabled.checked;
  const coversAtEnd = els.coversAtEnd.checked;
  const previewEnabled = els.previewEnabled.checked;
  const previewMode = els.previewCountMode.value;
  const previewManualCount = normalizePreviewPageCount();
  const outputLayout = currentOutputLayout();
  const excludeFirstPages = els.excludeFirstPages.checked;
  const excludedPageCount = normalizeExcludedPageCount();

  books.forEach((book) => {
    const marker = book.markerRecord;
    if (book.status === 'processing') return;
    const hadError = book.status === 'error';
    if (hadError) book.error = null;
    if (!marker) {
      book.status = customOutputHandle || previewEnabled || excludeFirstPages
        ? 'pending'
        : (!hadError && book.pdfNames.length > 0 ? 'done' : 'pending');
      book.notice = customOutputHandle || previewEnabled || excludeFirstPages
        ? 'New output options selected. Build required.'
        : null;
      return;
    }
    if (Number(marker.formatVersion) < DONE_FORMAT_VERSION) {
      book.status = 'pending';
      book.notice = 'Built by an older Bindery version. Rebuild required.';
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

    const matches =
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
    book.notice = matches ? null : 'Output or PDF settings changed. Rebuild required.';
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

  const isBusy = isProcessing || isExtracting;
  els.processAllBtn.disabled = isBusy || pending === 0;
  els.redoAllBtn.disabled = isBusy || books.length === 0;
  els.rescanBtn.disabled = isBusy;
  els.qualitySelect.disabled = isBusy;
  els.squareCoverCount.disabled = isBusy;
  els.coversAtEnd.disabled = isBusy;
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
  els.folderPath.classList.remove('hidden');
  els.folderPath.classList.add('flex');
  els.folderPathName.textContent = handle.name;

  await rescan();

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
    await rescan();
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

async function rescan() {
  if (!rootHandle) return;
  const previous = new Map(books.map((book) => [book.relativePath, book.sessionOutputs]));
  books = await scanBooks(rootHandle);
  books.forEach((book) => {
    book.sessionOutputs = previous.get(book.relativePath) || [];
  });
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
    excludeFirstPages, excludedPageCount, reserveOutputNames,
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
    const pdfBytes = await buildBookPdf(images, PDFLib, {
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
    const previewBytes = await buildPreviewPdf(pdfBytes, previewIndexes, PDFLib);

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
  if (isProcessing || targetBooks.length === 0) return;
  isProcessing = true;
  renderSummary();

  let completed = 0;
  const total = targetBooks.length;
  const qualityMode = els.qualitySelect.value;
  const squareCoverCount = normalizeSquareCoverCount();
  const coversAtEnd = els.coversAtEnd.checked;
  const pageNumbersEnabled = els.pageNumbersEnabled.checked;
  const searchableTextEnabled = els.searchableTextEnabled.checked;
  const outputHandle = customOutputHandle;
  const outputLayout = currentOutputLayout();
  const previewEnabled = els.previewEnabled.checked;
  const previewMode = els.previewCountMode.value;
  const previewManualCount = normalizePreviewPageCount();
  const excludeFirstPages = els.excludeFirstPages.checked;
  const excludedPageCount = normalizeExcludedPageCount();
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
  applyCurrentSettingsToBooks();
  renderAll();
});
els.excludedPageCount.addEventListener('input', () => {
  const parsed = Number.parseInt(els.excludedPageCount.value, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    els.excludedPageCountVisual.textContent = String(parsed);
    els.firstIncludedPage.textContent = String(parsed + 1);
  }
});
els.excludedPageCount.addEventListener('change', () => {
  applyCurrentSettingsToBooks();
  renderAll();
});
els.squareCoverCount.addEventListener('input', () => {
  const parsed = Number.parseInt(els.squareCoverCount.value, 10);
  if (Number.isFinite(parsed) && parsed >= 0) {
    els.squareCoverCountHelp.textContent = String(parsed);
  }
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
  els.pageNumberHelp.textContent = els.pageNumbersEnabled.checked
    ? 'Numbering starts at 1 after the covers. The bold badge is a separate PDF layer; page images keep their original geometry and bytes.'
    : 'Page numbering is off. Page images use their original geometry with no numbering layer.';
  applyCurrentSettingsToBooks();
  renderAll();
});
els.searchableTextEnabled.addEventListener('change', () => {
  els.searchableTextHelp.textContent = els.searchableTextEnabled.checked
    ? 'Searchable text is on. Interior pages are read on this computer and an invisible text layer is added over the untouched page image, so the words can be selected, copied, and searched. Covers are skipped. Building takes noticeably longer than an image-only PDF.'
    : 'Searchable text (OCR) is off for maximum speed, producing an image-only PDF. Turn it on to add an invisible selectable/searchable text layer without changing the page images.';
  applyCurrentSettingsToBooks();
  renderAll();
});

if (checkBrowserSupport()) {
  normalizeSquareCoverCount();
  normalizePreviewPageCount();
  normalizeExcludedPageCount();
  renderOutputSettings();
  updateSettingsSummary();
  refreshIcons();
}
