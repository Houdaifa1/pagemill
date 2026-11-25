import './pdf-lib.min.js?v=20260901-1';
import { mergePdfFiles } from './pdf-merge.js';

self.onmessage = async ({ data: files }) => {
  try {
    const bytes = await mergePdfFiles(files, self.PDFLib, (index, name) => {
      self.postMessage({ index, name });
    });
    self.postMessage({ bytes }, [bytes.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
