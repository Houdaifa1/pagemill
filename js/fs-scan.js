import { naturalCompare } from './natural-sort.js?v=20260830-3';
import { createImageSnapshot, imageSnapshotsMatch } from './source-state.js?v=20260830-11';

const IMAGE_EXT = /\.(png|jpe?g)$/i;
const PDF_EXT = /\.pdf$/i;
const RESERVED_DIRECTORIES = new Set(['_tpt_assets']);

// Recursively scans `rootHandle` and every subfolder beneath it. Each folder
// containing at least one directly-nested image is one "book" — including the
// picked folder itself, so pointing Bindery at a single book's folder works
// exactly like pointing it at a library of many. Keeping a book's images
// direct avoids accidentally mixing pages from parent and child folders.
export async function scanBooks(rootHandle) {
  const books = [];

  async function scanDirectory(handle, pathParts) {
    const imageHandles = [];
    const childDirectories = [];
    const pdfNames = [];
    const pdfHandles = [];
    let doneMarker = null;

    for await (const [childName, childHandle] of handle.entries()) {
      if (childHandle.kind === 'directory') {
        if (!RESERVED_DIRECTORIES.has(childName.toLowerCase())) {
          childDirectories.push({ name: childName, handle: childHandle });
        }
      } else if (IMAGE_EXT.test(childName)) {
        imageHandles.push({ name: childName, handle: childHandle });
      } else if (PDF_EXT.test(childName)) {
        pdfNames.push(childName);
        pdfHandles.push({ name: childName, handle: childHandle });
      } else if (childName === '.done') {
        doneMarker = childHandle;
      }
    }

    if (imageHandles.length > 0) {
      imageHandles.sort((a, b) => naturalCompare(a.name, b.name));
      pdfNames.sort(naturalCompare);
      pdfHandles.sort((a, b) => naturalCompare(a.name, b.name));
      const imageSnapshot = await createImageSnapshot(imageHandles);
      let generatedPdfName = null;
      let markerRecord = null;
      if (doneMarker) {
        try {
          const markerFile = await doneMarker.getFile();
          markerRecord = JSON.parse(await markerFile.text());
          if (typeof markerRecord.pdfFile === 'string' && markerRecord.pdfFile.trim()) {
            generatedPdfName = markerRecord.pdfFile;
          }
        } catch {
          // A malformed marker cannot prove which PDF belongs to Bindery.
          // Treat the folder as pending and keep every existing PDF protected.
        }
      }
      const sourceChanged = Boolean(doneMarker) &&
        !imageSnapshotsMatch(markerRecord?.imageSnapshot, imageSnapshot);
      const recordedPdfExists = generatedPdfName && pdfNames.some(
        (name) => name.toLowerCase() === generatedPdfName.toLowerCase()
      );
      // An empty `pathParts` means this is the picked root folder itself, which
      // has no path relative to the scan; fall back to its own folder name.
      books.push({
        name: pathParts.length > 0 ? pathParts[pathParts.length - 1] : handle.name,
        relativePath: pathParts.length > 0 ? pathParts.join(' / ') : handle.name,
        dirHandle: handle,
        imageHandles,
        imageCount: imageHandles.length,
        imageSnapshot,
        pdfNames,
        pdfHandles,
        generatedPdfName,
        markerRecord,
        sourceChanged,
        status: doneMarker
          ? (!sourceChanged && recordedPdfExists ? 'checking' : 'pending')
          : (pdfNames.length > 0 ? 'checking' : 'pending'),
        notice: sourceChanged
          ? 'Source images changed since the last PDF. Rebuild required.'
          : null,
        error: null,
      });
    }

    childDirectories.sort((a, b) => naturalCompare(a.name, b.name));
    await Promise.all(
      childDirectories.map((child) =>
        scanDirectory(child.handle, [...pathParts, child.name])
      )
    );
  }

  // Starting at the root itself (rather than at its children) means a folder of
  // loose page images is discovered as one book, and `scanDirectory` still
  // recurses into every subfolder for the library-of-many-books case.
  await scanDirectory(rootHandle, []);

  books.sort((a, b) => naturalCompare(a.relativePath, b.relativePath));
  return books;
}
