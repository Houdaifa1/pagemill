const IMAGE_EXT = /\.(png|jpe?g)$/i;
const ARCHIVE_EXT = /\.(zip|tar|tar\.gz|tgz|gz)$/i;
const ZIP_EOCD = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_OUTPUT_BYTES = 4 * 1024 * 1024 * 1024;
const utf8Decoder = new TextDecoder('utf-8');
const legacyDecoder = new TextDecoder('windows-1252');

function uint16(view, offset) {
  return view.getUint16(offset, true);
}

function uint32(view, offset) {
  return view.getUint32(offset, true);
}

function decodeZipName(bytes, utf8) {
  return (utf8 ? utf8Decoder : legacyDecoder).decode(bytes);
}

function cleanEntryName(path) {
  const parts = String(path).replaceAll('\\', '/').split('/').filter(Boolean);
  const name = parts.at(-1) || '';
  return name.replaceAll('\0', '').trim();
}

// macOS archivers add AppleDouble sidecars: a `__MACOSX` tree and `._name`
// resource forks that carry an image extension but hold metadata, not pixels.
// Extracting them would drop unreadable "pages" into a book folder, where the
// normal scan would pick them up and corrupt the resulting PDF.
function isAppleDoubleEntry(normalizedPath) {
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments.some((segment) => segment === '__MACOSX')
    || cleanEntryName(normalizedPath).startsWith('._');
}

function isImageEntry(path) {
  const normalized = String(path).replaceAll('\\', '/');
  return !isAppleDoubleEntry(normalized) && IMAGE_EXT.test(cleanEntryName(normalized));
}

async function decompress(bytes, format) {
  let stream;
  try {
    stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  } catch {
    throw new Error(`This browser cannot decompress ${format} archives.`);
  }
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new Error('The archive is damaged or contains invalid compressed data.');
  }
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let value = 0; value < 256; value += 1) {
      let crc = value;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      crcTable[value] = crc >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Each reader hands images to `onImage` as it finds them, one at a time, so a
// large archive never holds every extracted image in memory at once. The
// archive's own bytes are still read whole — ZIP needs random access to its
// trailing directory — so peak memory is one archive plus one image.
async function readZipImages(bytes, archiveName, onImage) {
  if (bytes.length < 22) throw new Error(`${archiveName}: incomplete ZIP file.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (uint32(view, offset) === ZIP_EOCD) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${archiveName}: ZIP directory was not found.`);
  if (uint16(view, eocd + 4) !== 0 || uint16(view, eocd + 6) !== 0) {
    throw new Error(`${archiveName}: multi-part ZIP files are not supported.`);
  }

  const entryCount = uint16(view, eocd + 10);
  const centralOffset = uint32(view, eocd + 16);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new Error(`${archiveName}: ZIP64 archives are not supported.`);
  }

  let imageCount = 0;
  let totalBytes = 0;
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || uint32(view, offset) !== ZIP_CENTRAL) {
      throw new Error(`${archiveName}: damaged ZIP directory.`);
    }
    const flags = uint16(view, offset + 8);
    const method = uint16(view, offset + 10);
    const expectedCrc = uint32(view, offset + 16);
    const compressedSize = uint32(view, offset + 20);
    const uncompressedSize = uint32(view, offset + 24);
    const nameLength = uint16(view, offset + 28);
    const extraLength = uint16(view, offset + 30);
    const commentLength = uint16(view, offset + 32);
    const localOffset = uint32(view, offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > bytes.length) throw new Error(`${archiveName}: truncated ZIP entry.`);

    const entryPath = decodeZipName(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
      Boolean(flags & 0x0800)
    );
    offset = nextOffset;
    if (!isImageEntry(entryPath)) continue;
    if (flags & 0x0001) throw new Error(`${archiveName}: password-protected ZIP images are not supported.`);
    if (![0, 8].includes(method)) {
      throw new Error(`${archiveName}: ${cleanEntryName(entryPath)} uses an unsupported ZIP compression method.`);
    }
    if (uncompressedSize > MAX_ENTRY_BYTES || totalBytes + uncompressedSize > MAX_ARCHIVE_OUTPUT_BYTES) {
      throw new Error(`${archiveName}: extracted image data is too large to process safely in the browser.`);
    }
    if (localOffset + 30 > bytes.length || uint32(view, localOffset) !== ZIP_LOCAL) {
      throw new Error(`${archiveName}: damaged local ZIP entry.`);
    }
    const localNameLength = uint16(view, localOffset + 26);
    const localExtraLength = uint16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.length) {
      throw new Error(`${archiveName}: truncated compressed image data.`);
    }
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    const output = method === 0 ? compressed.slice() : await decompress(compressed, 'deflate-raw');
    if (output.length !== uncompressedSize || crc32(output) !== expectedCrc) {
      throw new Error(`${archiveName}: ${cleanEntryName(entryPath)} failed its integrity check.`);
    }
    totalBytes += output.length;
    imageCount += 1;
    await onImage({ name: cleanEntryName(entryPath), bytes: output, sourcePath: entryPath });
  }
  return imageCount;
}

function tarString(bytes, offset, length) {
  const end = bytes.indexOf(0, offset);
  const boundedEnd = end < 0 || end > offset + length ? offset + length : end;
  return utf8Decoder.decode(bytes.subarray(offset, boundedEnd)).trim();
}

function tarSize(bytes, offset) {
  const value = tarString(bytes, offset, 12).replace(/\s/g, '');
  const parsed = Number.parseInt(value || '0', 8);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid TAR entry size.');
  return parsed;
}

function paxPath(bytes) {
  const text = utf8Decoder.decode(bytes);
  for (const record of text.split('\n')) {
    const equals = record.indexOf('=');
    if (equals < 0) continue;
    const keyStart = record.indexOf(' ') + 1;
    if (record.slice(keyStart, equals) === 'path') return record.slice(equals + 1);
  }
  return null;
}

async function readTarImages(bytes, archiveName, onImage) {
  let imageCount = 0;
  let totalBytes = 0;
  let offset = 0;
  let longName = null;
  let extendedPath = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarSize(bytes, offset + 124);
    const dataOffset = offset + 512;
    const dataEnd = dataOffset + size;
    if (dataEnd > bytes.length) throw new Error(`${archiveName}: truncated TAR entry.`);
    const type = String.fromCharCode(bytes[offset + 156] || 0);
    const prefix = tarString(bytes, offset + 345, 155);
    const headerName = tarString(bytes, offset, 100);
    const entryPath = extendedPath || longName || (prefix ? `${prefix}/${headerName}` : headerName);

    if (type === 'L') {
      longName = utf8Decoder.decode(bytes.subarray(dataOffset, dataEnd)).replace(/\0.*$/s, '').trim();
    } else if (type === 'x') {
      extendedPath = paxPath(bytes.subarray(dataOffset, dataEnd));
    } else {
      if ((type === '\0' || type === '0') && isImageEntry(entryPath)) {
        if (size > MAX_ENTRY_BYTES || totalBytes + size > MAX_ARCHIVE_OUTPUT_BYTES) {
          throw new Error(`${archiveName}: extracted image data is too large to process safely in the browser.`);
        }
        const output = bytes.slice(dataOffset, dataEnd);
        totalBytes += output.length;
        imageCount += 1;
        await onImage({ name: cleanEntryName(entryPath), bytes: output, sourcePath: entryPath });
      }
      longName = null;
      extendedPath = null;
    }
    offset = dataOffset + Math.ceil(size / 512) * 512;
  }
  return imageCount;
}

export function isSupportedArchiveName(name) {
  return ARCHIVE_EXT.test(name);
}

// Streams every image in one archive to `onImage`. Returns how many it found.
export async function streamArchiveImages(file, archiveName, onImage) {
  const lower = archiveName.toLowerCase();
  let bytes = new Uint8Array(await file.arrayBuffer());
  if (lower.endsWith('.zip')) return readZipImages(bytes, archiveName, onImage);
  if (lower.endsWith('.tar')) return readTarImages(bytes, archiveName, onImage);
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    bytes = await decompress(bytes, 'gzip');
    return readTarImages(bytes, archiveName, onImage);
  }
  if (lower.endsWith('.gz')) {
    bytes = await decompress(bytes, 'gzip');
    const outputName = cleanEntryName(archiveName.slice(0, -3));
    // A bare `.gz` holds exactly one member, named by stripping the suffix.
    if (!IMAGE_EXT.test(outputName) || isAppleDoubleEntry(outputName)) return 0;
    await onImage({ name: outputName, bytes, sourcePath: outputName });
    return 1;
  }
  throw new Error(`${archiveName}: unsupported archive format.`);
}

// Collecting wrapper: convenient for callers that want every image at once and
// know the archive is small. `extractImagesFromArchives` uses the streaming
// form instead so it never holds a whole archive's images in memory.
export async function readArchiveImages(file, archiveName = file.name || 'archive') {
  const images = [];
  await streamArchiveImages(file, archiveName, (image) => { images.push(image); });
  return images;
}

async function filesMatch(file, bytes) {
  if (file.size !== bytes.length) return false;
  const existing = new Uint8Array(await file.arrayBuffer());
  for (let index = 0; index < bytes.length; index += 1) {
    if (existing[index] !== bytes[index]) return false;
  }
  return true;
}

function numberedName(name, number) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return `${name} (${number})`;
  return `${name.slice(0, dot)} (${number})${name.slice(dot)}`;
}

async function writeImageSafely(directory, requestedName, bytes) {
  for (let number = 1; number < 10000; number += 1) {
    const name = number === 1 ? requestedName : numberedName(requestedName, number);
    try {
      const existingHandle = await directory.getFileHandle(name);
      if (await filesMatch(await existingHandle.getFile(), bytes)) {
        return { name, written: false };
      }
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;
      const outputHandle = await directory.getFileHandle(name, { create: true });
      const writable = await outputHandle.createWritable();
      try {
        await writable.write(bytes);
        await writable.close();
      } catch (writeError) {
        try { await writable.abort(); } catch {}
        throw writeError;
      }
      return { name, written: true };
    }
  }
  throw new Error(`Could not find a safe filename for ${requestedName}.`);
}

export async function extractImagesFromArchives(rootHandle, { onProgress = null } = {}) {
  const archives = [];
  async function scan(directory, pathParts) {
    for await (const [name, handle] of directory.entries()) {
      if (handle.kind === 'directory') {
        await scan(handle, [...pathParts, name]);
      } else if (isSupportedArchiveName(name)) {
        archives.push({ name, handle, directory, relativePath: [...pathParts, name].join(' / ') });
      }
    }
  }

  onProgress?.({ phase: 'scan', archivesFound: 0, archivesProcessed: 0, imagesWritten: 0 });
  await scan(rootHandle, []);

  let imagesWritten = 0;
  let imagesAlreadyPresent = 0;
  const failures = [];
  for (let index = 0; index < archives.length; index += 1) {
    const archive = archives[index];
    onProgress?.({
      phase: 'extract',
      archive: archive.relativePath,
      archivesFound: archives.length,
      archivesProcessed: index,
      imagesWritten,
    });
    try {
      const file = await archive.handle.getFile();
      // Each image is written as soon as it is decoded, then released, so a
      // large archive cannot pile every extracted page up in memory.
      await streamArchiveImages(file, archive.name, async (image) => {
        const result = await writeImageSafely(archive.directory, image.name, image.bytes);
        if (result.written) imagesWritten += 1;
        else imagesAlreadyPresent += 1;
      });
    } catch (err) {
      failures.push({ archive: archive.relativePath, error: err.message || String(err) });
    }
  }

  onProgress?.({
    phase: 'done',
    archivesFound: archives.length,
    archivesProcessed: archives.length,
    imagesWritten,
  });
  return { archivesFound: archives.length, imagesWritten, imagesAlreadyPresent, failures };
}
