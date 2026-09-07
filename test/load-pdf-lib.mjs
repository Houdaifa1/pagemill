import { readFileSync } from 'node:fs';

// The vendored pdf-lib is a UMD bundle. Node treats this project's .js files as
// ESM, so it has to be evaluated with CommonJS-shaped globals instead of being
// imported. `new Function` keeps it in the real global scope, which matters
// because pdf-lib type-checks arguments with `instanceof Array`.
export function loadPdfLib(baseUrl = import.meta.url) {
  const source = readFileSync(new URL('../js/pdf-lib.min.js', baseUrl), 'utf8');
  const shim = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'module', 'self', source)(shim.exports, shim, {});
  return shim.exports;
}
