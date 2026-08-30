// Reads one image file into pixel dimensions + bytes ready for pdf-lib embedding.
//
// Fast path (the common case): raw file bytes are embedded directly, with zero
// re-encoding. createImageBitmap() is used only to read width/height for page
// sizing, never to redraw the image.
//
// Slow path (PNG with an alpha channel only): pdf-lib's embedPng renders alpha
// as-is, which leaves book pages with unwanted transparency where a printed
// page must be opaque. When (and only when) the PNG actually carries an alpha
// channel, we composite it onto a white background via OffscreenCanvas and
// re-encode — the one deliberate exception to "never re-encode".

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes) {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

// PNG color types 4 and 6 carry alpha directly. Color types 0, 2, and 3 may
// instead use a tRNS chunk, so walk the chunk table as well. This avoids dark
// or transparent print backgrounds for indexed-color artwork.
function pngHasTransparency(bytes) {
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) return false;
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    if (type === 'tRNS') return true;
    if (type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

async function flattenPngOntoWhite(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function compressBitmapToJpeg(bitmap, quality) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

export async function readImageForPdf(file, { compress = false, quality = 0.85 } = {}) {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const ext = file.name.split('.').pop().toLowerCase();
  const isPngFile = ext === 'png' || isPng(bytes);

  const bitmap = await createImageBitmap(new Blob([bytes]));
  const width = bitmap.width;
  const height = bitmap.height;
  const hasTransparency = isPngFile && pngHasTransparency(bytes);

  if (compress) {
    const compressed = await compressBitmapToJpeg(bitmap, quality);
    let originalCandidate = bytes;
    if (hasTransparency) {
      originalCandidate = await flattenPngOntoWhite(bitmap);
    }
    bitmap.close();
    if (originalCandidate.length <= compressed.length) {
      return { type: isPngFile ? 'png' : 'jpg', bytes: originalCandidate, width, height };
    }
    return { type: 'jpg', bytes: compressed, width, height };
  }

  if (hasTransparency) {
    const flattened = await flattenPngOntoWhite(bitmap);
    bitmap.close();
    return { type: 'png', bytes: flattened, width, height };
  }

  bitmap.close();
  return { type: isPngFile ? 'png' : 'jpg', bytes, width, height };
}
