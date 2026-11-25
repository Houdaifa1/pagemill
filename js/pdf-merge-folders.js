import { naturalCompare } from './natural-sort.js?v=20260901-1';
import { chooseFlatOutputPdfName, choosePreviewPdfName, isSafePdfName } from './output-name.js?v=20260930-1';
import { orderPagesForBook } from './page-order.js?v=20260907-1';

const MANIFEST = '.bindery-pdf-merge.json';
const isCover = (name) => /(?:^|[ ._-])cover(?:[ ._-]|$)/i.test(name) && !/(?:^|[ ._-])back[ ._-]+cover/i.test(name);
const isThumbnail = (name) => /(?:^|[ ._-])thumb(?:nail)?s?(?:[ ._-]|\d|$)/i.test(name);
const frontMatterRank = (name) => isThumbnail(name) ? 1 : isCover(name) ? 0 : 2;
const isSubfolder = ([name, handle]) => handle.kind === 'directory' && !name.startsWith('.') && name !== '__MACOSX';

async function folderEntries(directory) {
  const entries = [];
  for await (const entry of directory.entries()) entries.push(entry);
  return entries;
}

async function listFolder(directory, path, entries, order) {
  const files = entries.filter(([name, handle]) => handle.kind === 'file' && !name.startsWith('.') && /\.pdf$/i.test(name));
  const marker = entries.find(([name]) => name === MANIFEST)?.[1];
  let outputs = [];
  if (marker) {
    try {
      const record = JSON.parse(await (await marker.getFile()).text());
      if (record.version !== 1 || !Array.isArray(record.outputs) || record.outputs.some((entry) =>
        !isSafePdfName(entry?.name) || typeof entry.sources !== 'string')) throw new Error();
      outputs = record.outputs;
    } catch {
      throw new Error(`${path} has an unreadable Bindery merge record (${MANIFEST}). Restore that record before merging this folder.`);
    }
  }

  const outputNames = new Set(outputs.map(({ name }) => name.toLowerCase()));
  const inputs = files.filter(([name]) => !outputNames.has(name.toLowerCase()));
  const byName = new Map(files);
  inputs.sort(([a], [b]) => order.coversAtEnd ? naturalCompare(a, b) :
    frontMatterRank(a) - frontMatterRank(b) || naturalCompare(a.toLowerCase(), b.toLowerCase()));
  const ordered = orderPagesForBook(inputs, {
    coversAtEnd: order.coversAtEnd,
    squareCoverCount: order.coverCount,
  });
  const coverFileCount = order.coversAtEnd
    ? Math.min(inputs.length, Math.max(0, Math.floor(Number(order.coverCount) || 0)))
    : inputs.filter(([name]) => frontMatterRank(name) < 2).length;
  const sourceFiles = await Promise.all(ordered.map(async ([name, handle]) => {
    try {
      return await handle.getFile();
    } catch (error) {
      throw new Error(`Could not read ${name}. ${error.message}`);
    }
  }));
  const signature = JSON.stringify(sourceFiles.map((file) => [file.name, file.size, file.lastModified]));
  async function findSaved(matches) {
    for (const entry of outputs.toReversed()) {
      if (!matches(entry) || !byName.has(entry.name)) continue;
      if ((await byName.get(entry.name).getFile()).size) return entry.name;
    }
    return null;
  }
  const fullName = await findSaved((entry) => entry.sources === signature);
  const previewRequired = order.previewEnabled && coverFileCount < sourceFiles.length;
  const previewKey = `preview-v1:${JSON.stringify([signature, coverFileCount, order.previewManualCount])}`;
  const previewName = previewRequired && fullName
    ? await findSaved((entry) => entry.previewFor === fullName && entry.sources === previewKey)
    : null;
  const name = fullName || chooseFlatOutputPdfName(`${directory.name} - Merged`, byName.keys());
  return {
    book: {
      directory, path, order, name, sources: sourceFiles, previewName,
      needsPreview: Boolean(fullName && previewRequired && !previewName),
      noWorksheetPreview: order.previewEnabled && !previewRequired,
      status: fullName && (!previewRequired || previewName) ? 'done' : 'pending',
    },
    fullName,
    coverFileCount,
    previewRequired,
    previewKey,
    outputs,
    signature,
    names: byName.keys(),
  };
}

export async function scanPdfFolders(root, {
  coversAtEnd = false, coverCount = 3, previewEnabled = false, previewManualCount = null,
} = {}) {
  const books = [];
  const order = { coversAtEnd, coverCount, previewEnabled, previewManualCount };
  async function walk(directory, path) {
    let entries = [];
    try {
      entries = await folderEntries(directory);
      const folder = await listFolder(directory, path, entries, order);
      if (folder.book.sources.length >= 2) books.push(folder.book);
    } catch (error) {
      books.push({ directory, path, status: 'error', error: error.message });
    }
    for (const [name, handle] of entries.filter(isSubfolder)) await walk(handle, `${path} / ${name}`);
  }
  await walk(root, root.name);
  return books.sort((a, b) => naturalCompare(a.path, b.path));
}

async function writeFolderFile(directory, name, data) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  try {
    await writer.write(data);
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

export async function savePdfFolder(book, buildOutputs, { redo = false } = {}) {
  const { directory, path, order } = book;
  const current = await listFolder(directory, path, await folderEntries(directory), order);
  if (current.book.sources.length < 2) throw new Error('At least two source PDFs are needed in this folder.');
  if (!redo && current.book.status === 'done') return current.book;
  const includeFull = redo || !current.fullName;
  const { pdfBytes, previewBytes } = await buildOutputs(current.book.sources, {
    includeFull,
    createPreview: current.previewRequired,
    coverFileCount: current.coverFileCount,
    previewManualCount: order.previewManualCount,
  });
  if ((includeFull && !pdfBytes) || (current.previewRequired && !previewBytes)) {
    throw new Error('Bindery could not create the requested PDFs.');
  }

  // Recheck the inputs and filenames before writing. Preparing a new output
  // never replaces an earlier fillable result, which may now contain answers.
  const latest = await listFolder(directory, path, await folderEntries(directory), order);
  if (latest.signature !== current.signature) throw new Error('Source PDFs changed during the merge. Rescan and try again.');
  if (!includeFull && latest.fullName !== current.fullName) throw new Error('The full PDF moved during the merge. Rescan and try again.');
  const names = [...latest.names];
  const name = includeFull ? chooseFlatOutputPdfName(`${directory.name} - Merged`, names) : current.fullName;
  const previewName = previewBytes ? choosePreviewPdfName(name, names) : null;
  const planned = [];
  if (pdfBytes) planned.push({ name, sources: latest.signature });
  if (previewName) planned.push({ name: previewName, sources: latest.previewKey, previewFor: name });
  const claimed = new Set(planned.map((entry) => entry.name));
  const previous = latest.outputs.filter((entry) => !claimed.has(entry.name));
  const record = { version: 1, outputs: [...previous, ...planned] };
  // Claim the filename before creating it so an interrupted or retried merge
  // cannot accidentally include its own output as a worksheet.
  await writeFolderFile(directory, MANIFEST, JSON.stringify(record));
  if (pdfBytes) await writeFolderFile(directory, name, pdfBytes);
  if (previewName) await writeFolderFile(directory, previewName, previewBytes);
  return { ...latest.book, name, previewName, needsPreview: false, status: 'done', outputsSaved: planned.length };
}
