// End-to-end check that the *vendored* OCR engine loads and runs in a real
// browser, that it only ever talks to this origin, and that the words it
// returns end up as invisible, extractable text in a real Bindery PDF.
//
// Kept out of test.js because it downloads ~6 MB of wasm + language data and
// takes a few seconds; test.js must stay fast and dependency-free.

import { buildBookPdf } from '../js/pdf-builder.js';

const logEl = document.getElementById('log');
const lines = [];
let failures = 0;

function log(msg, cls) {
  lines.push(cls ? `<span class="${cls}">${msg}</span>` : msg);
  logEl.innerHTML = lines.join('\n');
}
function assert(cond, msg) {
  if (cond) log(`PASS  ${msg}`, 'pass');
  else { failures += 1; log(`FAIL  ${msg}`, 'fail'); }
}

// Records every network request the page makes from now on, so the "nothing
// leaves this device" promise can be checked rather than assumed.
const requestedUrls = [];
const originalFetch = window.fetch;
window.fetch = function patchedFetch(input, init) {
  requestedUrls.push(typeof input === 'string' ? input : input.url);
  return originalFetch.call(this, input, init);
};
const originalOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
  requestedUrls.push(String(url));
  return originalOpen.call(this, method, url, ...rest);
};

// JPEG (not canvas PNG) so the book stays on the fast direct image engine:
// canvas PNGs are always RGBA, which correctly routes to the compatibility path.
async function renderTextImage(text) {
  const canvas = new OffscreenCanvas(1200, 400);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1200, 400);
  ctx.fillStyle = '#000000';
  ctx.font = '600 72px Helvetica, Arial, sans-serif';
  ctx.fillText(text, 40, 200);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
  return new Uint8Array(await blob.arrayBuffer());
}

async function main() {
  const before = performance.now();
  const ocr = await import('../js/ocr.js');
  log(`OCR module imported in ${(performance.now() - before).toFixed(0)} ms`);

  const phrase = 'The library opens today';
  const pageBytes = await renderTextImage(phrase);
  const coverBytes = await renderTextImage('COVER ART');

  const startedAt = performance.now();
  const statuses = new Set();
  const words = await ocr.recognizePageWords(new Blob([pageBytes], { type: 'image/jpeg' }), {
    onStatus: (message) => statuses.add(message.status),
  });
  const seconds = (performance.now() - startedAt) / 1000;
  log(`recognized ${words.length} words in ${seconds.toFixed(2)} s (statuses: ${[...statuses].join(', ')})`);

  assert(words.length >= 4, `the vendored engine recognizes real words (${words.length})`);
  const recognized = words.map((word) => word.text).join(' ');
  assert(recognized.includes('library'), `recognized text contains the printed phrase: "${recognized}"`);
  assert(
    words.every((word) => word.bbox && word.bbox.x1 > word.bbox.x0 && word.bbox.y1 > word.bbox.y0),
    'every recognized word carries a usable bounding box'
  );

  const external = requestedUrls.filter((url) => {
    if (url.startsWith('data:') || url.startsWith('blob:')) return false;
    return new URL(url, location.href).origin !== location.origin;
  });
  assert(
    external.length === 0,
    `the page made no off-origin requests (${requestedUrls.length} same-origin requests observed on the main thread)`
  );
  // Tesseract fetches its wasm core and language model from inside its Web
  // Worker, so those requests never reach the patches above. What can be
  // asserted here is that every path the module hands the worker is on this
  // origin; the browser's own network log is the check for the rest.
  const vendorUrls = [
    new URL('../vendor/tesseract/tesseract.esm.min.js', import.meta.url),
    new URL('../vendor/tesseract/worker.min.js', import.meta.url),
    new URL('../vendor/tesseract/tesseract-core-simd-lstm.wasm.js', import.meta.url),
    new URL('../vendor/tesseract/lang/eng.traineddata.gz', import.meta.url),
  ];
  assert(
    vendorUrls.every((url) => url.origin === location.origin),
    'every Tesseract asset path points at this origin, not a CDN'
  );
  const vendorProbes = await Promise.all(
    vendorUrls.map((url) => originalFetch(url, { method: 'HEAD' }).then((r) => r.ok).catch(() => false))
  );
  assert(
    vendorProbes.every(Boolean),
    `all four vendored Tesseract assets are actually served locally (${vendorProbes.join(', ')})`
  );

  // The words must survive all the way into a real PDF.
  const handles = [
    { name: 'cover.jpg', handle: { getFile: async () => new File([coverBytes], 'cover.jpg', { type: 'image/jpeg' }) } },
    { name: 'page-001.jpg', handle: { getFile: async () => new File([pageBytes], 'page-001.jpg', { type: 'image/jpeg' }) } },
  ];
  const pdfBytes = await buildBookPdf(handles, window.PDFLib, {
    squareCoverCount: 1,
    pageNumbersEnabled: true,
    searchableText: true,
    recognizeWords: (file) => ocr.recognizePageWords(file),
    title: 'Live OCR check',
  });
  const pdfText = new TextDecoder('latin1').decode(pdfBytes);
  assert(pdfText.includes('3 Tr'), 'the built PDF contains an invisible (mode 3) text layer');
  assert(pdfText.includes('(library ) Tj'), 'a recognized word appears as a real PDF text operator');
  assert(pdfText.includes('Bindery direct image engine'), 'the fast direct image engine was still used');

  await ocr.terminateOcrWorker();
  log('worker terminated cleanly');

  log('');
  log(failures === 0 ? 'ALL LIVE OCR CHECKS PASSED' : `${failures} LIVE OCR CHECK(S) FAILED`, failures === 0 ? 'pass' : 'fail');
}

main().catch((err) => {
  failures += 1;
  log(`UNCAUGHT ERROR: ${err && err.stack ? err.stack : err}`, 'fail');
});
