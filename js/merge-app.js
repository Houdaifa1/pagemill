import { savePdfFolder, scanPdfFolders } from './pdf-merge-folders.js';

const empty = document.getElementById('merge-empty');
const library = document.getElementById('merge-library');
const choose = document.getElementById('choose-pdf-folder');
const change = document.getElementById('change-pdf-folder');
const rescanButton = document.getElementById('rescan-pdf-folders');
const mergeAll = document.getElementById('merge-all-pdfs');
const coversAtEnd = document.getElementById('merge-covers-at-end');
const coverCount = document.getElementById('merge-cover-count');
const orderHelp = document.getElementById('merge-order-help');
const previewEnabled = document.getElementById('merge-preview-enabled');
const previewOptions = document.getElementById('merge-preview-options');
const previewMode = document.getElementById('merge-preview-mode');
const previewCount = document.getElementById('merge-preview-count');
const list = document.getElementById('merge-folders');
const libraryName = document.getElementById('merge-root-name');
const count = document.getElementById('merge-count');
const noFolders = document.getElementById('merge-no-folders');
const status = document.getElementById('merge-status');
const errorMessage = document.getElementById('merge-error');
const rowTemplate = document.getElementById('merge-folder-row');
const openDetails = new Set();
const labels = { pending: 'Pending', processing: 'Merging', done: 'Saved', error: 'Error' };
const folderAccess = typeof window.showDirectoryPicker === 'function';
let root = null;
let books = [];
let busy = false;

function renderFolders() {
  empty.hidden = Boolean(root);
  library.hidden = !root;
  noFolders.hidden = busy || books.length > 0;
  choose.disabled = busy || !folderAccess;
  change.disabled = busy;
  rescanButton.disabled = busy;
  coversAtEnd.disabled = busy;
  coverCount.disabled = busy || !coversAtEnd.checked;
  previewEnabled.disabled = busy;
  previewMode.disabled = busy;
  previewCount.disabled = busy;
  previewOptions.hidden = !previewEnabled.checked;
  previewCount.hidden = previewMode.value !== 'manual';
  orderHelp.textContent = coversAtEnd.checked
    ? 'Count the cover and thumbnails together. Bindery moves that many PDFs from the end to the front.'
    : 'Cover and thumbnail filenames come first automatically.';
  const pending = books.filter((book) => book.status === 'pending').length;
  const saved = books.filter((book) => book.status === 'done').length;
  mergeAll.disabled = busy || pending === 0;
  libraryName.textContent = root?.name || '';
  count.textContent = `${pending} pending · ${saved} saved`;

  list.replaceChildren(...books.map((book) => {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector('.merge-folder-path').textContent = book.path;
    row.querySelector('.merge-folder-error').textContent = book.error || '';
    row.querySelector('.merge-folder-preview').textContent = book.previewName ? `Preview · ${book.previewName}` :
      book.noWorksheetPreview ? 'No worksheet pages for a preview.' : '';
    const details = row.querySelector('details');
    details.hidden = !book.sources;
    if (book.sources) {
      details.querySelector('summary').textContent = `${book.sources.length} PDFs · ${book.name}`;
      for (const file of book.sources) {
        const entry = document.createElement('li');
        entry.textContent = file.name;
        details.querySelector('ol').append(entry);
      }
      details.open = openDetails.has(book.path);
      details.addEventListener('toggle', () => {
        if (details.open) openDetails.add(book.path);
        else openDetails.delete(book.path);
      });
    }
    const pill = row.querySelector('.status-pill');
    pill.textContent = labels[book.status];
    pill.classList.add(`status-pill--${book.status}`);
    const action = row.querySelector('button');
    action.hidden = !book.sources;
    action.disabled = busy;
    action.textContent = book.status === 'done' ? 'Redo PDF' : book.needsPreview ? 'Save preview' : 'Merge PDF';
    action.addEventListener('click', () => processFolders([book], book.status === 'done'));
    return row;
  }));
  window.lucide?.createIcons();
}

async function rescan() {
  busy = true;
  errorMessage.textContent = '';
  status.textContent = 'Looking for PDFs…';
  renderFolders();
  try {
    books = await scanPdfFolders(root, {
      coversAtEnd: coversAtEnd.checked,
      coverCount: coverCount.valueAsNumber,
      previewEnabled: previewEnabled.checked,
      previewManualCount: previewMode.value === 'manual' ? previewCount.valueAsNumber : null,
    });
  } catch (error) {
    errorMessage.textContent = `Could not read this folder. ${error.message}`;
  } finally {
    busy = false;
    status.textContent = '';
    renderFolders();
  }
}

async function changeSettings({ currentTarget }) {
  if (busy || !root) return;
  for (const input of [coverCount, previewCount]) {
    const value = input.valueAsNumber;
    input.value = String(Number.isFinite(value) ? Math.max(Number(input.min), Math.floor(value)) : 3);
  }
  await rescan();
  if (document.activeElement === document.body) currentTarget.focus();
}

async function chooseFolder() {
  if (busy) return;
  try {
    root = await window.showDirectoryPicker({ mode: 'readwrite', id: 'bindery-merge' });
  } catch (error) {
    if (error.name !== 'AbortError') errorMessage.textContent = `Could not open this folder. ${error.message}`;
    return;
  }
  books = [];
  openDetails.clear();
  await rescan();
  (mergeAll.disabled ? change : mergeAll).focus();
}

function mergeInWorker(files, options, path) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./merge-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.result || data.error) {
        worker.terminate();
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
        return;
      }
      status.textContent = `${path} · Reading PDF ${data.index + 1} of ${files.length} — ${data.name}`;
    };
    worker.onmessageerror = worker.onerror = () => {
      worker.terminate();
      reject(new Error('The PDF merger could not start. Reload the page and try again.'));
    };
    worker.postMessage({ files, options });
  });
}

async function processFolders(targets, redo = false) {
  if (busy || !targets.length) return;
  busy = true;
  errorMessage.textContent = '';
  let saved = 0;
  let failed = 0;
  for (const book of targets) {
    book.status = 'processing';
    book.error = '';
    status.textContent = `Merging ${book.path}…`;
    renderFolders();
    try {
      const save = () => savePdfFolder(book, (files, options) => mergeInWorker(files, options, book.path), { redo });
      const result = navigator.locks ? await navigator.locks.request('bindery-pdf-merge', save) : await save();
      Object.assign(book, result);
      saved += result.outputsSaved || 0;
    } catch (error) {
      failed += 1;
      book.status = 'error';
      book.error = error.message;
    }
  }
  busy = false;
  const result = `${saved} ${saved === 1 ? 'PDF' : 'PDFs'} saved beside the source files.`;
  status.textContent = failed ? `${result} ${failed} ${failed === 1 ? 'folder needs' : 'folders need'} attention.` : result;
  renderFolders();
}

choose.addEventListener('click', chooseFolder);
change.addEventListener('click', chooseFolder);
rescanButton.addEventListener('click', rescan);
for (const option of [coversAtEnd, coverCount, previewEnabled, previewMode, previewCount]) {
  option.addEventListener('change', changeSettings);
}
mergeAll.addEventListener('click', () => processFolders(books.filter((book) => book.status === 'pending')));
if (!folderAccess) errorMessage.textContent = 'Open Bindery in Chrome or Edge to choose folders and save merged PDFs beside your worksheets.';
renderFolders();
