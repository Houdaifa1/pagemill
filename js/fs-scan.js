import { naturalCompare } from './natural-sort.js?v=20260831-3';
import { createImageSnapshot, imageSnapshotsMatch } from './source-state.js?v=20260831-3';

const PNG_EXT = /\.png$/i;
const PDF_EXT = /\.pdf$/i;
const RESERVED_DIRECTORIES = new Set(['_tpt_assets']);

// Every directory containing directly nested PNG files is one book. Child
// folders are scanned independently so pages from different books never mix.
export async function scanBooks(rootHandle) {
  const books = [];

  async function scanDirectory(handle, pathParts) {
    const imageHandles = [];
    const childDirectories = [];
    const pdfHandles = [];
    let doneMarker = null;

    for await (const [childName, childHandle] of handle.entries()) {
      if (childHandle.kind === 'directory') {
        if (!RESERVED_DIRECTORIES.has(childName.toLowerCase())) {
          childDirectories.push({ name: childName, handle: childHandle });
        }
      } else if (PNG_EXT.test(childName)) {
        imageHandles.push({ name: childName, handle: childHandle });
      } else if (PDF_EXT.test(childName)) {
        pdfHandles.push({ name: childName, handle: childHandle });
      } else if (childName === '.done') {
        doneMarker = childHandle;
      }
    }

    if (imageHandles.length > 0) {
      imageHandles.sort((left, right) => naturalCompare(left.name, right.name));
      pdfHandles.sort((left, right) => naturalCompare(left.name, right.name));
      const sourceSnapshot = await createImageSnapshot(imageHandles);

      let markerRecord = null;
      if (doneMarker) {
        try {
          markerRecord = JSON.parse(await (await doneMarker.getFile()).text());
        } catch {
          markerRecord = null;
        }
      }

      const generatedPdfName = typeof markerRecord?.pdfFile === 'string'
        ? markerRecord.pdfFile
        : null;
      const ownedPdf = pdfHandles.find(
        (entry) => entry.name.toLowerCase() === generatedPdfName?.toLowerCase()
      );
      const previousSnapshot = markerRecord?.sourceSnapshot || markerRecord?.imageSnapshot;
      const sourceChanged = Boolean(markerRecord) &&
        !imageSnapshotsMatch(previousSnapshot, sourceSnapshot);

      let ownedPdfMatches = false;
      if (ownedPdf && !sourceChanged) {
        const file = await ownedPdf.handle.getFile();
        ownedPdfMatches = !Number.isFinite(markerRecord?.pdfSize) || markerRecord.pdfSize === file.size;
      }

      let status = 'pending';
      let notice = null;
      if (sourceChanged) {
        notice = 'PNG pages changed since the last PDF. Rebuild required.';
      } else if (markerRecord && ownedPdfMatches) {
        status = 'done';
        notice = `Ready: ${imageHandles.length} PNG pages already processed.`;
      } else if (markerRecord && !ownedPdf) {
        notice = 'The PDF recorded by Bindery is missing. Rebuild required.';
      } else if (markerRecord && !ownedPdfMatches) {
        notice = 'The existing Bindery PDF changed. Rebuild required.';
      } else if (pdfHandles.length === 1) {
        status = 'done';
        notice = 'Existing PDF found. Use Check PDF if you want full validation.';
      } else if (pdfHandles.length > 1) {
        notice = 'Multiple existing PDFs found. Process to create a separate Bindery PDF.';
      }

      books.push({
        name: pathParts.length ? pathParts[pathParts.length - 1] : handle.name,
        relativePath: pathParts.length ? pathParts.join(' / ') : handle.name,
        dirHandle: handle,
        pageHandles: imageHandles,
        imageHandles,
        pageCount: imageHandles.length,
        imageCount: imageHandles.length,
        sourceSnapshot,
        imageSnapshot: sourceSnapshot,
        pdfNames: pdfHandles.map((entry) => entry.name),
        pdfHandles,
        generatedPdfName,
        markerRecord,
        sourceChanged,
        status,
        notice,
        error: null,
      });
    }

    childDirectories.sort((left, right) => naturalCompare(left.name, right.name));
    for (let start = 0; start < childDirectories.length; start += 4) {
      const batch = childDirectories.slice(start, start + 4);
      await Promise.all(batch.map((child) =>
        scanDirectory(child.handle, [...pathParts, child.name])
      ));
    }
  }

  await scanDirectory(rootHandle, []);
  books.sort((left, right) => naturalCompare(left.relativePath, right.relativePath));
  return books;
}
