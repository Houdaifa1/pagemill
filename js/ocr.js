// Local, opt-in OCR for the "Searchable text" setting.
//
// Everything here is lazily loaded: the Tesseract runtime, the WebAssembly
// core, and the language model are only fetched the first time a book is built
// with searchable text switched on. With the setting off (the default) this
// module is never imported at all, so there is no download, no worker startup,
// and no measurable cost.
//
// The engine, the wasm core, and the English model are vendored under
// js/vendor/tesseract/ and served from this app's own origin. No page image and
// no recognized text is ever sent anywhere — recognition happens inside a Web
// Worker in the same browser tab.

export const DEFAULT_OCR_LANGUAGE = 'eng';

const VENDOR_BASE = new URL('./vendor/tesseract/', import.meta.url).href;
const WORKER_PATH = `${VENDOR_BASE}worker.min.js`;
const LANG_PATH = `${VENDOR_BASE}lang`;
const ENGINE_MODULE = `${VENDOR_BASE}tesseract.esm.min.js`;
// OEM 1 = LSTM only, which matches the vendored -lstm wasm cores.
const OCR_ENGINE_MODE = 1;

let enginePromise = null;
let workerPromise = null;
let workerLanguage = null;
// One shared worker serves every book, so recognition is serialized through
// this chain instead of racing two concurrently-processed books.
let queue = Promise.resolve();

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

/**
 * Returns the single shared Tesseract worker, creating it on first use.
 * `onStatus` receives Tesseract's own loading/recognition progress events.
 */
export async function getOcrWorker(language = DEFAULT_OCR_LANGUAGE, onStatus = null) {
  if (workerPromise && workerLanguage !== language) {
    await terminateOcrWorker();
  }
  if (!workerPromise) {
    workerLanguage = language;
    const engine = await loadEngine();
    workerPromise = engine
      .createWorker(language, OCR_ENGINE_MODE, {
        workerPath: WORKER_PATH,
        corePath: VENDOR_BASE,
        langPath: LANG_PATH,
        gzip: true,
        logger: (message) => onStatus?.(message),
      })
      .catch((err) => {
        workerPromise = null;
        workerLanguage = null;
        throw new Error(`Could not start the OCR engine: ${err.message || err}`);
      });
  }
  return workerPromise;
}

/** Shuts the shared worker down and forgets it, so the next run starts clean. */
export async function terminateOcrWorker() {
  const pending = workerPromise;
  workerPromise = null;
  workerLanguage = null;
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // A worker that already died cannot be terminated again; nothing to do.
  }
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
export function recognizePageWords(image, { language = DEFAULT_OCR_LANGUAGE, onStatus = null } = {}) {
  const run = async () => {
    const worker = await getOcrWorker(language, onStatus);
    try {
      const { data } = await worker.recognize(image, {}, { text: false, blocks: true });
      return flattenRecognizedWords(data);
    } catch (err) {
      // A crashed wasm worker cannot be reused; drop it so the next book
      // starts from a clean engine rather than inheriting a broken one.
      await terminateOcrWorker();
      throw new Error(`OCR failed: ${err && err.message ? err.message : err}`);
    }
  };

  const result = queue.then(run, run);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
