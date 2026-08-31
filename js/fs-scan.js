import { naturalCompare } from './natural-sort.js?v=20260830-3';

const IMAGE_EXT = /\.(png|jpe?g)$/i;
const PDF_EXT = /\.pdf$/i;

// Recursively scans every subfolder of `rootHandle`. Each folder containing
// at least one directly-nested image is one "book". Keeping a book's images
// direct avoids accidentally mixing pages from parent and child folders.
export async function scanBooks(rootHandle) {
  const books = [];

  async function scanDirectory(handle, pathParts) {
    const imageHandles = [];
    const childDirectories = [];
    const pdfNames = [];
    let doneMarker = null;

    for await (const [childName, childHandle] of handle.entries()) {
      if (childHandle.kind === 'directory') {
        childDirectories.push({ name: childName, handle: childHandle });
      } else if (IMAGE_EXT.test(childName)) {
        imageHandles.push({ name: childName, handle: childHandle });
      } else if (PDF_EXT.test(childName)) {
        pdfNames.push(childName);
      } else if (childName === '.done') {
        doneMarker = childHandle;
      }
    }

    if (imageHandles.length > 0) {
      imageHandles.sort((a, b) => naturalCompare(a.name, b.name));
      pdfNames.sort(naturalCompare);
      let generatedPdfName = null;
      if (doneMarker) {
        try {
          const markerFile = await doneMarker.getFile();
          const marker = JSON.parse(await markerFile.text());
          if (typeof marker.pdfFile === 'string' && marker.pdfFile.trim()) {
            generatedPdfName = marker.pdfFile;
          }
        } catch {
          // A malformed marker still means "done", but it cannot prove which
          // PDF belongs to Bindery, so existing PDFs remain protected.
        }
      }
      books.push({
        name: pathParts[pathParts.length - 1],
        relativePath: pathParts.join(' / '),
        dirHandle: handle,
        imageHandles,
        imageCount: imageHandles.length,
        pdfNames,
        generatedPdfName,
        status: doneMarker || pdfNames.length > 0 ? 'done' : 'pending',
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
