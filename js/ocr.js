// Local, opt-in OCR for the "Searchable text" setting.
//
// Everything here is lazily loaded: the Tesseract runtime, the WebAssembly
// core, and the language model are only fetched the first time a book is built
// with searchable text switched on. With the setting off (the default) this
// module is never imported at all, so there is no download, no worker startup,
// and no measurable cost.
//
// The engine, the wasm core, and the English model are vendored under
// vendor/tesseract/ and served from this app's own origin. No page image and
// no recognized text is ever sent anywhere — recognition happens inside a Web
// Worker in the same browser tab.

export const DEFAULT_OCR_LANGUAGE = 'eng';

const VENDOR_BASE = new URL('../vendor/tesseract/', import.meta.url).href;
const WORKER_PATH = `${VENDOR_BASE}worker.min.js`;
const LANG_PATH = `${VENDOR_BASE}lang`;
const ENGINE_MODULE = `${VENDOR_BASE}tesseract.esm.min.js`;
// OEM 1 = LSTM only, which matches the vendored -lstm wasm cores.
const OCR_ENGINE_MODE = 1;

// Recognition is CPU-bound and single-threaded per worker, so a small pool of
// workers is what turns a 12-core machine from 1x into ~4x. The pool is capped
// rather than sized to core count: each worker holds its own WebAssembly heap
// and one decoded page, and unbounded workers would trade a freeze for a crash.
export const MAX_OCR_WORKERS = 4;

export function recommendedOcrConcurrency(cores = globalThis.navigator?.hardwareConcurrency) {
  const detected = Number(cores);
  if (!Number.isFinite(detected) || detected < 2) return 1;
  return Math.max(1, Math.min(MAX_OCR_WORKERS, Math.floor(detected / 3)));
}

let enginePromise = null;
let poolLanguage = null;
let poolSize = 1;
// Workers currently free to take a page, and callers waiting for one.
let idleWorkers = [];
let liveWorkerCount = 0;
let waiters = [];

async function loadEngine() {
  if (!enginePromise) {
    // The vendored Tesseract ESM bundle exposes its API on the default export.
    enginePromise = import(ENGINE_MODULE)
      .then((module) => module.default || module)
      .catch((err) => {
        enginePromise = null;
        throw new Error(`Could not load the local OCR engine: ${err.message}`);
      });
  }
  return enginePromise;
}

/** Sets how many pages may be recognized at once. Takes effect on next use. */
export async function configureOcrPool(size) {
  const next = Math.max(1, Math.min(MAX_OCR_WORKERS, Math.floor(Number(size) || 1)));
  if (next === poolSize) return;
  // Shrinking mid-batch would strand in-flight work, so the pool is rebuilt
  // from scratch; callers set this before a batch, not during one.
  await terminateOcrWorker();
  poolSize = next;
}

async function createWorker(language, onStatus) {
  const engine = await loadEngine();
  return engine.createWorker(language, OCR_ENGINE_MODE, {
    workerPath: WORKER_PATH,
    corePath: VENDOR_BASE,
    langPath: LANG_PATH,
    gzip: true,
    logger: (message) => onStatus?.(message),
  });
}

// Hands out a free worker, starting a new one only while the pool has room.
async function acquireWorker(language, onStatus) {
  if (poolLanguage !== null && poolLanguage !== language) {
    await terminateOcrWorker();
  }
  poolLanguage = language;

  const existing = idleWorkers.pop();
  if (existing) return existing;

  if (liveWorkerCount < poolSize) {
    liveWorkerCount += 1;
    try {
      return await createWorker(language, onStatus);
    } catch (err) {
      liveWorkerCount -= 1;
      throw new Error(`Could not start the OCR engine: ${err.message || err}`);
    }
  }

  return new Promise((resolve) => waiters.push(resolve));
}

// Returns a worker to the pool, or hands it straight to the next page waiting.
function releaseWorker(worker) {
  const waiter = waiters.shift();
  if (waiter) waiter(worker);
  else idleWorkers.push(worker);
}

// A crashed worker cannot be reused. Drop it and let the pool start a fresh
// one on demand, so one bad page never poisons the rest of the batch.
async function discardWorker(worker) {
  liveWorkerCount = Math.max(0, liveWorkerCount - 1);
  try {
    await worker.terminate();
  } catch {
    // Already dead; nothing to clean up.
  }
  const waiter = waiters.shift();
  if (waiter) {
    // Someone is blocked on a worker that no longer exists. Give the pool room
    // to build a replacement instead of leaving that page waiting forever.
    acquireWorker(poolLanguage, null).then(waiter, () => waiter(null));
  }
}

/** Kept for callers and tests that just want one ready worker. */
export async function getOcrWorker(language = DEFAULT_OCR_LANGUAGE, onStatus = null) {
  const worker = await acquireWorker(language, onStatus);
  releaseWorker(worker);
  return worker;
}

/** Shuts every pooled worker down, so the next batch starts clean. */
export async function terminateOcrWorker() {
  const workers = idleWorkers;
  idleWorkers = [];
  waiters = [];
  liveWorkerCount = 0;
  poolLanguage = null;
  await Promise.all(workers.map(async (worker) => {
    try {
      await worker.terminate();
    } catch {
      // A worker that already died cannot be terminated again.
    }
  }));
}

// Tesseract returns a block/paragraph/line/word tree. Walking it keeps natural
// reading order (top-to-bottom, left-to-right) instead of relying on a flat
// list, which matters for how copied sentences come out of a PDF viewer.
export function flattenRecognizedWords(data) {
  const words = [];
  const push = (word) => {
    if (!word || !word.bbox) return;
    const text = typeof word.text === 'string' ? word.text.trim() : '';
    if (!text) return;
    words.push({ text, bbox: word.bbox, confidence: word.confidence ?? 0 });
  };

  if (Array.isArray(data?.blocks) && data.blocks.length > 0) {
    for (const block of data.blocks) {
      for (const paragraph of block?.paragraphs || []) {
        for (const line of paragraph?.lines || []) {
          for (const word of line?.words || []) push(word);
        }
      }
    }
    if (words.length > 0) return words;
  }

  for (const word of data?.words || []) push(word);
  return words;
}

/**
 * Recognizes one page image and returns its words in reading order.
 * Rejects on failure so the caller can fail that one book loudly instead of
 * writing a PDF that merely pretends to be searchable.
 */
export async function recognizePageWords(
  image,
  { language = DEFAULT_OCR_LANGUAGE, onStatus = null } = {}
) {
  const worker = await acquireWorker(language, onStatus);
  if (!worker) throw new Error('OCR failed: no worker available');
  try {
    const { data } = await worker.recognize(image, {}, { text: false, blocks: true });
    const words = flattenRecognizedWords(data);
    releaseWorker(worker);
    return words;
  } catch (err) {
    await discardWorker(worker);
    throw new Error(`OCR failed: ${err && err.message ? err.message : err}`);
  }
}
