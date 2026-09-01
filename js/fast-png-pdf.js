const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);
const encoder = new TextEncoder();
const PAGE_NUMBER_FONT_SIZE = 10;
const PAGE_NUMBER_BASELINE = 11;

function readUint32(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, false);
}

function chunkType(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

export function parseDirectRgbPng(bytes, name = 'PNG') {
  if (bytes.length < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return { supported: false, reason: `${name}: invalid PNG signature` };
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let sawHeader = false;
  let sawEnd = false;
  const idatChunks = [];
  let idatLength = 0;
  let offset = 8;

  while (offset + 12 <= bytes.length) {
    const length = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const nextOffset = dataOffset + length + 4;
    if (nextOffset > bytes.length) {
      return { supported: false, reason: `${name}: truncated PNG chunk` };
    }

    const type = chunkType(bytes, typeOffset);
    if (type === 'IHDR') {
      if (length !== 13 || sawHeader) {
        return { supported: false, reason: `${name}: invalid PNG header` };
      }
      width = readUint32(bytes, dataOffset);
      height = readUint32(bytes, dataOffset + 4);
      bitDepth = bytes[dataOffset + 8];
      colorType = bytes[dataOffset + 9];
      const compression = bytes[dataOffset + 10];
      const filter = bytes[dataOffset + 11];
      interlace = bytes[dataOffset + 12];
      if (width === 0 || height === 0 || compression !== 0 || filter !== 0) {
        return { supported: false, reason: `${name}: unsupported PNG header` };
      }
      sawHeader = true;
    } else if (type === 'IDAT') {
      idatChunks.push(bytes.subarray(dataOffset, dataOffset + length));
      idatLength += length;
    } else if (type === 'IEND') {
      sawEnd = true;
      break;
    }

    offset = nextOffset;
  }

  if (!sawHeader || !sawEnd || idatChunks.length === 0) {
    return { supported: false, reason: `${name}: incomplete PNG data` };
  }

  // PDF can consume the original PNG scanline stream directly for standard,
  // non-interlaced 8-bit RGB files. Alpha, indexed, grayscale, and interlaced
  // PNGs use the compatibility path in pdf-builder.js.
  if (bitDepth !== 8 || colorType !== 2 || interlace !== 0) {
    return { supported: false, reason: `${name}: PNG requires compatibility mode` };
  }

  return { supported: true, format: 'png', width, height, idatChunks, idatLength };
}

export function parseDirectJpeg(bytes, name = 'JPEG') {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return { supported: false, reason: `${name}: invalid JPEG signature` };
  }

  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;

    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;

    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;

    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) break;
      const bitsPerComponent = bytes[offset + 2];
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const components = bytes[offset + 7];
      if (!width || !height || bitsPerComponent !== 8 || ![1, 3].includes(components)) {
        return { supported: false, reason: `${name}: JPEG requires compatibility mode` };
      }
      return {
        supported: true,
        format: 'jpg',
        width,
        height,
        bitsPerComponent,
        colorSpace: components === 1 ? '/DeviceGray' : '/DeviceRGB',
        bytes,
      };
    }

    offset += segmentLength;
  }

  return { supported: false, reason: `${name}: unsupported or incomplete JPEG data` };
}

function escapePdfString(value) {
  return String(value).replace(/([\\()])/g, '\\$1');
}

function number(value) {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

export function buildDirectImagePdf(
  images,
  {
    pageWidth,
    pageHeight,
    pageSizeForPage = null,
    placementForPage,
    pageNumberForPage = null,
    title = 'Bindery PDF',
    onPageProcessed = null,
  }
) {
  const parts = [];
  const offsets = [];
  let byteLength = 0;

  function append(part) {
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    parts.push(bytes);
    byteLength += bytes.length;
  }

  function addObject(objectNumber, bodyParts) {
    offsets[objectNumber] = byteLength;
    append(`${objectNumber} 0 obj\n`);
    for (const part of bodyParts) append(part);
    append('\nendobj\n');
  }

  append('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  addObject(1, ['<< /Type /Catalog /Pages 2 0 R >>']);

  const pageObjectNumbers = images.map((_, index) => 3 + index * 3);
  const pageNumbers = images.map((image, index) => pageNumberForPage?.(image, index) ?? null);
  const hasPageNumbers = pageNumbers.some((value) => value !== null);
  const fontObject = 3 + images.length * 3;
  addObject(2, [
    `<< /Type /Pages /Count ${images.length} /Kids [${pageObjectNumbers.map((value) => `${value} 0 R`).join(' ')}] >>`,
  ]);

  images.forEach((image, index) => {
    const pageObject = pageObjectNumbers[index];
    const imageObject = pageObject + 1;
    const contentObject = pageObject + 2;
    const pageSize = pageSizeForPage?.(image, index) || { width: pageWidth, height: pageHeight };
    const placement = placementForPage(image.width, image.height, index, pageSize);
    const pageNumber = pageNumbers[index];
    const contentParts = [
      'q',
      `${number(placement.width)} 0 0 ${number(placement.height)} ${number(placement.x)} ${number(placement.y)} cm`,
      '/Im0 Do',
      'Q',
    ];
    if (pageNumber !== null) {
      const pageNumberText = String(pageNumber);
      // Helvetica's tabular digits are 556 font units wide. Centering with
      // the real glyph width keeps one-, two-, and three-digit books aligned.
      const textWidth = pageNumberText.length * PAGE_NUMBER_FONT_SIZE * 0.556;
      const textX = (pageSize.width - textWidth) / 2;
      contentParts.push(
        'BT',
        `/F0 ${PAGE_NUMBER_FONT_SIZE} Tf`,
        '0.34 g',
        `1 0 0 1 ${number(textX)} ${PAGE_NUMBER_BASELINE} Tm`,
        `(${pageNumberText}) Tj`,
        'ET'
      );
    }
    contentParts.push('');
    const content = contentParts.join('\n');

    const fontResource = pageNumber !== null
      ? ` /Font << /F0 ${fontObject} 0 R >>`
      : '';

    addObject(pageObject, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(pageSize.width)} ${number(pageSize.height)}] `,
      `/Resources << /XObject << /Im0 ${imageObject} 0 R >>${fontResource} >> /Contents ${contentObject} 0 R >>`,
    ]);
    if (image.format === 'jpg') {
      addObject(imageObject, [
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} `,
        `/ColorSpace ${image.colorSpace} /BitsPerComponent ${image.bitsPerComponent} /Interpolate false `,
        `/Filter /DCTDecode /Length ${image.bytes.length} >>\nstream\n`,
        image.bytes,
        '\nendstream',
      ]);
    } else {
      addObject(imageObject, [
        `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} `,
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Interpolate false `,
        `/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${image.width} >> `,
        `/Length ${image.idatLength} >>\nstream\n`,
        ...image.idatChunks,
        '\nendstream',
      ]);
    }
    const contentBytes = encoder.encode(content);
    addObject(contentObject, [
      `<< /Length ${contentBytes.length} >>\nstream\n`,
      contentBytes,
      'endstream',
    ]);

    onPageProcessed?.({
      index,
      name: image.name,
      width: image.width,
      height: image.height,
      pageWidth: pageSize.width,
      pageHeight: pageSize.height,
      pageKind: pageSize.kind || 'page',
      placement,
      pageNumber,
    });
  });

  if (hasPageNumbers) {
    addObject(fontObject, [
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    ]);
  }

  const infoObject = fontObject + (hasPageNumbers ? 1 : 0);
  addObject(infoObject, [
    `<< /Title (${escapePdfString(title)}) /Subject (Digital book assembled from square cover pages and US Letter interiors) `,
    '/Creator (Bindery) /Producer (Bindery direct image engine) >>',
  ]);

  const xrefOffset = byteLength;
  append(`xref\n0 ${infoObject + 1}\n`);
  append('0000000000 65535 f \n');
  for (let objectNumber = 1; objectNumber <= infoObject; objectNumber += 1) {
    append(`${String(offsets[objectNumber]).padStart(10, '0')} 00000 n \n`);
  }
  append(`trailer\n<< /Size ${infoObject + 1} /Root 1 0 R /Info ${infoObject} 0 R >>\n`);
  append(`startxref\n${xrefOffset}\n%%EOF\n`);

  const output = new Uint8Array(byteLength);
  let outputOffset = 0;
  for (const part of parts) {
    output.set(part, outputOffset);
    outputOffset += part.length;
  }
  return output;
}


// Backward-compatible export for existing callers and fixtures.
export const buildDirectRgbPngPdf = buildDirectImagePdf;
