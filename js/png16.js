// pdf-lib's PNG embedder converts samples to 8 bits. Keep the full samples for
// original-size covers by embedding 16-bit color and alpha streams directly.
const ADAM7_PASSES = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
  [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

function paeth(left, above, upperLeft) {
  const distanceLeft = Math.abs(above - upperLeft);
  const distanceAbove = Math.abs(left - upperLeft);
  const distanceUpperLeft = Math.abs(left + above - 2 * upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  return distanceAbove <= distanceUpperLeft ? above : upperLeft;
}

function unfilterRow(row, previous, bytesPerPixel, filter) {
  if (filter === 0) return;
  if (filter > 4) throw new Error('Invalid 16-bit PNG row filter.');
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const above = previous[i];
    const upperLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
    switch (filter) {
      case 1: row[i] += left; break;
      case 2: row[i] += above; break;
      case 3: row[i] += (left + above) >> 1; break;
      case 4: row[i] += paeth(left, above, upperLeft); break;
    }
  }
}

export async function embed16BitPng(bytes, pdfDoc) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a ||
      view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) {
    throw new Error('Invalid 16-bit PNG header.');
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const colorType = bytes[25];
  const interlace = bytes[28];
  if (!width || !height || ![0, 2, 4, 6].includes(colorType) || bytes[26] || bytes[27] || interlace > 1) {
    throw new Error('Invalid 16-bit PNG header.');
  }
  const colorChannels = colorType === 0 || colorType === 4 ? 1 : 3;
  const hasAlpha = colorType === 4 || colorType === 6;
  const colorBytes = colorChannels * 2;
  const bytesPerPixel = colorBytes + (hasAlpha ? 2 : 0);
  const chunks = [];
  let colorKey;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const dataOffset = offset + 8;
    const next = dataOffset + length + 4;
    if (next > bytes.length) throw new Error('Truncated 16-bit PNG chunk.');
    const chunkType = String.fromCharCode(...bytes.subarray(offset + 4, dataOffset));
    if (chunkType === 'IDAT') chunks.push(bytes.subarray(dataOffset, next - 4));
    if (chunkType === 'tRNS' && !hasAlpha && length === colorBytes) {
      colorKey = [];
      for (let i = 0; i < colorBytes; i += 2) {
        const sample = view.getUint16(dataOffset + i);
        colorKey.push(sample, sample);
      }
    }
    if (chunkType === 'IEND') break;
    offset = next;
  }

  const decompressed = new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate'));
  const scanlines = new Uint8Array(await new Response(decompressed).arrayBuffer());
  const colors = new Uint8Array(width * height * colorBytes);
  const alpha = hasAlpha ? new Uint8Array(width * height * 2) : null;
  const passes = interlace ? ADAM7_PASSES : [[0, 0, 1, 1]];
  let offset = 0;
  for (const [startX, startY, stepX, stepY] of passes) {
    if (startX >= width || startY >= height) continue;
    const rowLength = Math.ceil((width - startX) / stepX) * bytesPerPixel;
    let previous = new Uint8Array(rowLength);
    for (let y = startY; y < height; y += stepY) {
      const filter = scanlines[offset];
      const row = scanlines.subarray(offset + 1, offset + 1 + rowLength);
      if (row.length !== rowLength) throw new Error('Truncated 16-bit PNG scanlines.');
      unfilterRow(row, previous, bytesPerPixel, filter);
      if (stepX === 1 && !hasAlpha) {
        colors.set(row, y * rowLength);
      } else {
        for (let x = startX, pixelOffset = 0; x < width; x += stepX, pixelOffset += bytesPerPixel) {
          const pixel = y * width + x;
          colors.set(row.subarray(pixelOffset, pixelOffset + colorBytes), pixel * colorBytes);
          if (alpha) {
            alpha[pixel * 2] = row[pixelOffset + colorBytes];
            alpha[pixel * 2 + 1] = row[pixelOffset + colorBytes + 1];
          }
        }
      }
      previous = row;
      offset += rowLength + 1;
    }
  }
  if (offset !== scanlines.length) throw new Error('Invalid 16-bit PNG scanline length.');

  const { context } = pdfDoc;
  const attributes = { Type: 'XObject', Subtype: 'Image', Width: width, Height: height, BitsPerComponent: 16 };
  const colorAttributes = { ...attributes, ColorSpace: colorChannels === 1 ? 'DeviceGray' : 'DeviceRGB' };
  if (alpha) {
    colorAttributes.SMask = context.register(context.flateStream(alpha, { ...attributes, ColorSpace: 'DeviceGray' }));
  } else if (colorKey) {
    colorAttributes.Mask = colorKey;
  }
  const ref = context.register(context.flateStream(colors, colorAttributes));
  return { ref, width, height };
}
