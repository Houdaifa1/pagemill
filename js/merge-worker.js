import './pdf-lib.min.js?v=20260901-1';
import { buildPdfMergeOutput } from './pdf-merge.js?v=20261125-2';

self.onmessage = async ({ data: { files, options } }) => {
  try {
    const result = await buildPdfMergeOutput(files, self.PDFLib, options, (index, name) => {
      self.postMessage({ index, name });
    });
    const buffers = Object.values(result).filter(Boolean).map((bytes) => bytes.buffer);
    self.postMessage({ result }, buffers);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
