import {
  chooseFlatOutputPdfName,
  chooseOutputPdfName,
  choosePreviewPdfName,
  isSafePdfName,
} from './output-name.js?v=20260930-1';

export const OUTPUT_LAYOUT_FLAT = 'flat';
export const OUTPUT_LAYOUT_FOLDERS = 'folders';

// Without a chosen destination, keep the original beside-the-images behavior.
export async function resolveOutputDirectory(book, outputRootHandle, layout = OUTPUT_LAYOUT_FOLDERS) {
  if (!outputRootHandle) return book.dirHandle;
  if (layout === OUTPUT_LAYOUT_FLAT) return outputRootHandle;
  if (layout !== OUTPUT_LAYOUT_FOLDERS) throw new Error('Unknown output layout.');
  let directory = outputRootHandle;
  for (const part of book.outputPathParts) {
    directory = await directory.getDirectoryHandle(part, { create: true });
  }
  return directory;
}

export async function listPdfNames(directory) {
  const names = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === 'file' && /\.pdf$/i.test(name)) names.push(name);
  }
  return names;
}

// Reserve both filenames before a concurrent PDF build writes either one.
// One folder listing is shared by every book going into a flat result folder.
export function createOutputNameAllocator() {
  const existingByKey = new Map();
  const reservedByKey = new Map();

  return async ({ book, directory, key, layout, ownedOutput, previewEnabled }) => {
    if (!existingByKey.has(key)) {
      existingByKey.set(key, listPdfNames(directory).then((names) =>
        new Set(names.map((name) => name.toLowerCase()))
      ));
    }
    const existing = await existingByKey.get(key);
    let reserved = reservedByKey.get(key);
    if (!reserved) {
      reserved = new Set();
      reservedByKey.set(key, reserved);
    }
    const occupied = new Set([...existing, ...reserved]);

    const ownedPdfName = ownedOutput?.pdfName || ownedOutput?.pdfFile;
    const canReusePdf = isSafePdfName(ownedPdfName) &&
      !reserved.has(ownedPdfName.toLowerCase());
    const pdfName = canReusePdf
      ? ownedPdfName
      : (layout === OUTPUT_LAYOUT_FLAT
          ? chooseFlatOutputPdfName(book.name, occupied)
          : chooseOutputPdfName({ name: book.name, pdfNames: [...occupied] }));
    reserved.add(pdfName.toLowerCase());
    occupied.add(pdfName.toLowerCase());

    const ownedPreviewName = ownedOutput?.previewName || ownedOutput?.previewFile;
    const previewName = previewEnabled
      ? choosePreviewPdfName(
          pdfName,
          [...occupied],
          isSafePdfName(ownedPreviewName) && !reserved.has(ownedPreviewName.toLowerCase())
            ? ownedPreviewName
            : null
        )
      : null;
    if (previewName) reserved.add(previewName.toLowerCase());
    return { pdfName, previewName };
  };
}
