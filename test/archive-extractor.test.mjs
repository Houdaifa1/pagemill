import assert from 'node:assert/strict';
import { extractImagesFromArchives, streamArchiveImages } from '../js/archive-extractor.js';

const encoder = new TextEncoder();

function crc32(bytes) {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    table[value] = crc >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function compress(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const source = Uint8Array.from(entry.bytes);
    const method = entry.deflate ? 8 : 0;
    const packed = entry.deflate ? await compress(source, 'deflate-raw') : source;
    const checksum = crc32(source);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, packed.length, true);
    localView.setUint32(22, source.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, packed);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, packed.length, true);
    centralView.setUint32(24, source.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, localOffset, true);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + packed.length;
  }

  const central = concat(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, localOffset, true);
  return concat([...localParts, central, end]);
}

function writeAscii(target, offset, length, value) {
  const bytes = encoder.encode(value);
  target.set(bytes.subarray(0, length), offset);
}

function makeTar(entries) {
  const parts = [];
  for (const entry of entries) {
    const bytes = Uint8Array.from(entry.bytes);
    const header = new Uint8Array(512);
    writeAscii(header, 0, 100, entry.name);
    writeAscii(header, 100, 8, '0000644\0');
    writeAscii(header, 108, 8, '0000000\0');
    writeAscii(header, 116, 8, '0000000\0');
    writeAscii(header, 124, 12, `${bytes.length.toString(8).padStart(11, '0')}\0`);
    writeAscii(header, 136, 12, '00000000000\0');
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    writeAscii(header, 257, 6, 'ustar\0');
    writeAscii(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    const padding = new Uint8Array(Math.ceil(bytes.length / 512) * 512 - bytes.length);
    parts.push(header, bytes, padding);
  }
  parts.push(new Uint8Array(1024));
  return concat(parts);
}

class MemoryFileHandle {
  kind = 'file';

  constructor(name, bytes) {
    this.name = name;
    this.bytes = Uint8Array.from(bytes);
  }

  async getFile() {
    const snapshot = this.bytes.slice();
    return {
      name: this.name,
      size: snapshot.length,
      arrayBuffer: async () => snapshot.buffer.slice(
        snapshot.byteOffset,
        snapshot.byteOffset + snapshot.byteLength
      ),
    };
  }

  async createWritable() {
    let pending = null;
    return {
      write: async (bytes) => { pending = Uint8Array.from(bytes); },
      close: async () => { this.bytes = pending || new Uint8Array(); },
      abort: async () => { pending = null; },
    };
  }
}

class MemoryDirectoryHandle {
  kind = 'directory';

  constructor(name) {
    this.name = name;
    this.children = new Map();
  }

  addFile(name, bytes) {
    const handle = new MemoryFileHandle(name, bytes);
    this.children.set(name, handle);
    return handle;
  }

  addDirectory(name) {
    const handle = new MemoryDirectoryHandle(name);
    this.children.set(name, handle);
    return handle;
  }

  async *entries() {
    yield* this.children.entries();
  }

  async getFileHandle(name, options = {}) {
    const found = this.children.get(name);
    if (found?.kind === 'file') return found;
    if (!found && options.create) return this.addFile(name, new Uint8Array());
    const error = new Error(`File not found: ${name}`);
    error.name = 'NotFoundError';
    throw error;
  }
}

async function bytesOf(directory, name) {
  const file = await (await directory.getFileHandle(name)).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

const root = new MemoryDirectoryHandle('Library');
const book = root.addDirectory('Book One');
const nested = book.addDirectory('extras');
const protectedOriginal = Uint8Array.from([99, 98, 97, 96]);
book.addFile('page-001.png', protectedOriginal);

const pngBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const jpgBytes = Uint8Array.from([255, 216, 255, 224, 10, 20, 30, 255, 217]);
const nestedPngBytes = Uint8Array.from([137, 80, 78, 71, 44, 55, 66]);
const gzipJpgBytes = Uint8Array.from([255, 216, 77, 88, 99, 255, 217]);

const zipBytes = await makeZip([
  { name: 'nested/page-001.png', bytes: pngBytes, deflate: true },
  { name: 'preview/photo.jpg', bytes: jpgBytes, deflate: false },
  { name: 'notes.txt', bytes: encoder.encode('ignored'), deflate: true },
]);
const tgzBytes = await compress(makeTar([
  { name: 'deep/page-003.png', bytes: nestedPngBytes },
]), 'gzip');
const singleGzip = await compress(gzipJpgBytes, 'gzip');

book.addFile('pages.zip', zipBytes);
nested.addFile('more.tgz', tgzBytes);
nested.addFile('single.jpeg.gz', singleGzip);
nested.addFile('unsupported.7z', Uint8Array.from([1, 2, 3]));

const first = await extractImagesFromArchives(root);
assert.equal(first.archivesFound, 3, 'finds supported archives recursively');
assert.equal(first.imagesWritten, 4, 'extracts only images from all supported archives');
assert.equal(first.imagesAlreadyPresent, 0);
assert.deepEqual(first.failures, []);
assert.deepEqual(await bytesOf(book, 'page-001.png'), protectedOriginal, 'never overwrites an existing image');
assert.deepEqual(await bytesOf(book, 'page-001 (2).png'), pngBytes, 'copies deflated ZIP bytes exactly');
assert.deepEqual(await bytesOf(book, 'photo.jpg'), jpgBytes, 'copies stored ZIP bytes exactly');
assert.deepEqual(await bytesOf(nested, 'page-003.png'), nestedPngBytes, 'extracts TAR.GZ into the archive folder');
assert.deepEqual(await bytesOf(nested, 'single.jpeg'), gzipJpgBytes, 'extracts single-image GZ files');
assert.deepEqual(await bytesOf(book, 'pages.zip'), zipBytes, 'keeps the original archive intact');

const second = await extractImagesFromArchives(root);
assert.equal(second.imagesWritten, 0, 'a second run creates no duplicates');
assert.equal(second.imagesAlreadyPresent, 4, 'a second run recognizes exact existing bytes');
assert.deepEqual(second.failures, []);

// ---- plain uncompressed TAR ----
const tarRoot = new MemoryDirectoryHandle('Tar');
tarRoot.addFile('plain.tar', makeTar([{ name: 'dir/page-1.png', bytes: pngBytes }]));
const tarRun = await extractImagesFromArchives(tarRoot);
assert.equal(tarRun.imagesWritten, 1, 'plain .tar archives are extracted');
assert.deepEqual(await bytesOf(tarRoot, 'page-1.png'), pngBytes, 'plain .tar bytes are copied exactly');

// ---- .tar.gz double extension (distinct code path from .tgz) ----
const targzRoot = new MemoryDirectoryHandle('TarGz');
targzRoot.addFile('bundle.tar.gz', await compress(makeTar([{ name: 'p.png', bytes: pngBytes }]), 'gzip'));
const targzRun = await extractImagesFromArchives(targzRoot);
assert.equal(targzRun.imagesWritten, 1, '.tar.gz archives are extracted');
assert.deepEqual(await bytesOf(targzRoot, 'p.png'), pngBytes, '.tar.gz bytes are copied exactly');

// ---- macOS AppleDouble sidecars must never become pages ----
// `._name` forks and `__MACOSX` entries carry image extensions but hold
// metadata. Writing them would add unreadable pages to a book folder.
const macRoot = new MemoryDirectoryHandle('Mac');
const appleDoubleJunk = Uint8Array.from([0, 5, 22, 7]);
macRoot.addFile('mac.tar', makeTar([
  { name: '__MACOSX/._page-1.png', bytes: appleDoubleJunk },
  { name: 'book/__MACOSX/._page-2.png', bytes: appleDoubleJunk },
  { name: 'book/._page-1.png', bytes: appleDoubleJunk },
  { name: 'book/page-1.png', bytes: pngBytes },
]));
const macRun = await extractImagesFromArchives(macRoot);
assert.equal(macRun.imagesWritten, 1, 'only the real image is extracted from a macOS archive');
assert.deepEqual(await bytesOf(macRoot, 'page-1.png'), pngBytes, 'the real image survives AppleDouble filtering');
assert.deepEqual(
  [...macRoot.children.keys()].filter((name) => name.startsWith('._')),
  [],
  'no AppleDouble resource fork is ever written'
);

// ---- one damaged archive must not stop the batch ----
const mixedRoot = new MemoryDirectoryHandle('Mixed');
mixedRoot.addFile('broken.zip', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
mixedRoot.addFile('good.tar', makeTar([{ name: 'ok.png', bytes: pngBytes }]));
const mixedRun = await extractImagesFromArchives(mixedRoot);
assert.equal(mixedRun.archivesFound, 2, 'both archives are discovered');
assert.equal(mixedRun.imagesWritten, 1, 'the healthy archive is still extracted');
assert.equal(mixedRun.failures.length, 1, 'the damaged archive is reported as a failure');
assert.match(mixedRun.failures[0].archive, /broken\.zip/, 'the failure names the damaged archive');
assert.deepEqual(await bytesOf(mixedRoot, 'ok.png'), pngBytes, 'a damaged neighbour does not block extraction');

// ---- entry paths can never escape the archive's own folder ----
const traversalRoot = new MemoryDirectoryHandle('Traversal');
const traversalBook = traversalRoot.addDirectory('book');
traversalBook.addFile('evil.tar', makeTar([
  { name: '../../../escaped.png', bytes: pngBytes },
  { name: '/absolute/rooted.png', bytes: pngBytes },
]));
const traversalRun = await extractImagesFromArchives(traversalRoot);
assert.equal(traversalRun.imagesWritten, 2, 'traversal entries are extracted, not skipped');
assert.deepEqual(
  [...traversalRoot.children.keys()].sort(),
  ['book'],
  'nothing is written outside the archive folder'
);
assert.deepEqual(
  [...traversalBook.children.keys()].sort(),
  ['escaped.png', 'evil.tar', 'rooted.png'],
  'traversal entries land flat beside their archive, stripped to a basename'
);

// ---- unsupported formats are left completely alone ----
const unsupportedRoot = new MemoryDirectoryHandle('Unsupported');
unsupportedRoot.addFile('bundle.7z', Uint8Array.from([1, 2, 3]));
unsupportedRoot.addFile('notes.txt', encoder.encode('hello'));
const unsupportedRun = await extractImagesFromArchives(unsupportedRoot);
assert.equal(unsupportedRun.archivesFound, 0, 'unsupported formats are not treated as archives');
assert.equal(unsupportedRun.imagesWritten, 0, 'nothing is written for unsupported formats');
assert.deepEqual(
  [...unsupportedRoot.children.keys()].sort(),
  ['bundle.7z', 'notes.txt'],
  'unsupported files are left untouched'
);

// ---- images are streamed out one at a time, never buffered together ----
// Guards the memory contract: a big archive must not hold every extracted
// image at once, so the writer has to see image 1 before image 2 is decoded.
const streamRoot = new MemoryDirectoryHandle('Stream');
streamRoot.addFile('many.tar', makeTar([
  { name: 'a.png', bytes: pngBytes },
  { name: 'b.png', bytes: pngBytes },
  { name: 'c.png', bytes: pngBytes },
]));
let liveAtOnce = 0;
let peakLiveAtOnce = 0;
const streamFile = await (await streamRoot.getFileHandle('many.tar')).getFile();
const streamed = await streamArchiveImages(streamFile, 'many.tar', async () => {
  liveAtOnce += 1;
  peakLiveAtOnce = Math.max(peakLiveAtOnce, liveAtOnce);
  await Promise.resolve();
  liveAtOnce -= 1;
});
assert.equal(streamed, 3, 'the stream reports how many images it found');
assert.equal(peakLiveAtOnce, 1, 'only one extracted image is in flight at a time');

console.log('Archive extractor QA passed: ZIP/TAR/TAR.GZ/TGZ/GZ, exact bytes, no overwrite,');
console.log('idempotent rerun, AppleDouble filtered, damage isolated, traversal contained, streamed writes.');
