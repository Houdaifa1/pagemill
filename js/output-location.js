// A chosen destination mirrors the selected source folder, then its book folders.
// The normal path still writes directly beside each book's images.
export async function resolveOutputDirectory(book, outputRootHandle) {
  if (!outputRootHandle) return book.dirHandle;
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
