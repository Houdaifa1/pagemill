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
    action.textContent = book.status === 'done' ? 'Redo PDF' : 'Merge PDF';
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
    books = await scanPdfFolders(root, { coversAtEnd: coversAtEnd.checked, coverCount: coverCount.valueAsNumber });
  } catch (error) {
    errorMessage.textContent = `Could not read this folder. ${error.message}`;
  } finally {
    busy = false;
    status.textContent = '';
    renderFolders();
  }
}

async function changeOrder({ currentTarget }) {
  if (busy || !root) return;
  const value = coverCount.valueAsNumber;
  coverCount.value = String(Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 3);
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

function mergeInWorker(files, path) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./merge-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.bytes || data.error) {
        worker.terminate();
        if (data.error) reject(new Error(data.error));
        else resolve(data.bytes);
        return;
      }
      status.textContent = `${path} · Reading PDF ${data.index + 1} of ${files.length} — ${data.name}`;
    };
    worker.onmessageerror = worker.onerror = () => {
      worker.terminate();
      reject(new Error('The PDF merger could not start. Reload the page and try again.'));
    };
    worker.postMessage(files);
  });
}

async function processFolders(targets, redo = false) {
  if (busy || !targets.length) return;
  busy = true;
  errorMessage.textContent = '';
  let saved = 0;
  for (const book of targets) {
    book.status = 'processing';
    book.error = '';
    status.textContent = `Merging ${book.path}…`;
    renderFolders();
    try {
      const save = () => savePdfFolder(book, (files) => mergeInWorker(files, book.path), { redo });
      const result = navigator.locks ? await navigator.locks.request('bindery-pdf-merge', save) : await save();
      Object.assign(book, result);
      saved += 1;
    } catch (error) {
      book.status = 'error';
      book.error = error.message;
    }
  }
  busy = false;
  const failed = targets.length - saved;
  const result = `${saved} ${saved === 1 ? 'PDF' : 'PDFs'} saved beside the source files.`;
  status.textContent = failed ? `${result} ${failed} ${failed === 1 ? 'folder needs' : 'folders need'} attention.` : result;
  renderFolders();
}

choose.addEventListener('click', chooseFolder);
change.addEventListener('click', chooseFolder);
rescanButton.addEventListener('click', rescan);
coversAtEnd.addEventListener('change', changeOrder);
coverCount.addEventListener('change', changeOrder);
mergeAll.addEventListener('click', () => processFolders(books.filter((book) => book.status === 'pending')));
if (!folderAccess) errorMessage.textContent = 'Open Bindery in Chrome or Edge to choose folders and save merged PDFs beside your worksheets.';
renderFolders();
