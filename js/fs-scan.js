import { naturalCompare } from './natural-sort.js?v=20260830-3';
import { createImageSnapshot, imageSnapshotsMatch } from './source-state.js?v=20260830-11';

const IMAGE_EXT = /\.(png|jpe?g)$/i;
const PDF_EXT = /\.pdf$/i;
const RESERVED_DIRECTORIES = new Set(['_tpt_assets']);

// Recursively scans every subfolder of `rootHandle`. Each folder containing
// at least one directly-nested image is one "book". Keeping a book's images
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
      books.push({
        name: pathParts[pathParts.length - 1],
        relativePath: pathParts.join(' / '),
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

  const topDirectories = [];
  for await (const [name, handle] of rootHandle.entries()) {
    if (handle.kind === 'directory') topDirectories.push({ name, handle });
  }
  topDirectories.sort((a, b) => naturalCompare(a.name, b.name));
  await Promise.all(
    topDirectories.map((child) => scanDirectory(child.handle, [child.name]))
  );

  books.sort((a, b) => naturalCompare(a.relativePath, b.relativePath));
  return books;
}
