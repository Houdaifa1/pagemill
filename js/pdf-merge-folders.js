import { naturalCompare } from './natural-sort.js?v=20260901-1';
import { chooseFlatOutputPdfName, isSafePdfName } from './output-name.js?v=20260930-1';
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
  const sourceFiles = await Promise.all(ordered.map(async ([name, handle]) => {
    try {
      return await handle.getFile();
    } catch (error) {
      throw new Error(`Could not read ${name}. ${error.message}`);
    }
  }));
  const signature = JSON.stringify(sourceFiles.map((file) => [file.name, file.size, file.lastModified]));
  let latest = null;
  for (const entry of outputs.toReversed()) {
    if (entry.sources !== signature || !byName.has(entry.name)) continue;
    const saved = await byName.get(entry.name).getFile();
    if (!saved.size) continue;
    latest = entry.name;
    break;
  }
  const name = latest || chooseFlatOutputPdfName(`${directory.name} - Merged`, byName.keys());
  return {
    book: { directory, path, order, name, sources: sourceFiles, status: latest ? 'done' : 'pending' },
    outputs,
    signature,
    names: byName.keys(),
  };
}

export async function scanPdfFolders(root, { coversAtEnd = false, coverCount = 3 } = {}) {
  const books = [];
  const order = { coversAtEnd, coverCount };
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

export async function savePdfFolder(book, merge, { redo = false } = {}) {
  const { directory, path, order } = book;
  const current = await listFolder(directory, path, await folderEntries(directory), order);
  if (current.book.sources.length < 2) throw new Error('At least two source PDFs are needed in this folder.');
  if (!redo && current.book.status === 'done') return current.book;
  const bytes = await merge(current.book.sources);

  // Recheck the inputs and filenames before writing. Preparing a new output
  // never replaces an earlier fillable result, which may now contain answers.
  const latest = await listFolder(directory, path, await folderEntries(directory), order);
  if (latest.signature !== current.signature) throw new Error('Source PDFs changed during the merge. Rescan and try again.');
  const name = chooseFlatOutputPdfName(`${directory.name} - Merged`, latest.names);
  const previous = latest.outputs.filter((entry) => entry.name !== name);
  const record = { version: 1, outputs: [...previous, { name, sources: latest.signature }] };
  // Claim the filename before creating it so an interrupted or retried merge
  // cannot accidentally include its own output as a worksheet.
  await writeFolderFile(directory, MANIFEST, JSON.stringify(record));
  await writeFolderFile(directory, name, bytes);
  return { ...latest.book, name, status: 'done' };
}
