import { readImageForPdf } from './image-io.js?v=20260830-11';

// Source pixel dimensions are treated as 300 DPI when converting to PDF
// points (72 points per inch) — see README for why this assumption was made
// and what it means for images with different embedded DPI.
const ASSUMED_DPI = 300;
const POINTS_PER_INCH = 72;

export const PAGE_FORMATS = {
  letter: { width: 8.5 * POINTS_PER_INCH, height: 11 * POINTS_PER_INCH },
  a4: { width: 595.28, height: 841.89 },
};

function pixelsToPoints(px) {
  return (px / ASSUMED_DPI) * POINTS_PER_INCH;
}

export function getPdfPageSize(image, pageFormat = 'original') {
  if (PAGE_FORMATS[pageFormat]) return PAGE_FORMATS[pageFormat];
  return {
    width: pixelsToPoints(image.width),
    height: pixelsToPoints(image.height),
  };
}

export function fitImageToPage(image, pageSize) {
  const scale = Math.min(pageSize.width / image.width, pageSize.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return {
    x: (pageSize.width - width) / 2,
    y: (pageSize.height - height) / 2,
    width,
    height,
  };
}

// Builds one PDF from a book's already-naturally-sorted image handles.
// Pages are read, decoded, and embedded one at a time. A book containing many
// large scans would otherwise keep every decoded bitmap in memory at once and
// can freeze the browser.
export async function buildBookPdf(
  imageHandles,
  PDFLib,
  {
    compress = false,
    pageFormat = 'original',
    title = 'Bindery PDF',
    onPageProcessed = null,
  } = {}
) {
  const pdfDoc = await PDFLib.PDFDocument.create();
  pdfDoc.setTitle(title);
  pdfDoc.setSubject('Print-ready book assembled from ordered page images');
  pdfDoc.setCreator('Bindery');
  pdfDoc.setProducer('Bindery');

  for (let index = 0; index < imageHandles.length; index++) {
    const { handle, name } = imageHandles[index];
    const file = await handle.getFile();
    const image = await readImageForPdf(file, { compress });
    const embedded =
      image.type === 'png'
        ? await pdfDoc.embedPng(image.bytes)
        : await pdfDoc.embedJpg(image.bytes);

    const pageSize = getPdfPageSize(image, pageFormat);
    const placement = pageFormat === 'original'
      ? { x: 0, y: 0, width: pageSize.width, height: pageSize.height }
      : fitImageToPage(image, pageSize);
    const page = pdfDoc.addPage([pageSize.width, pageSize.height]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: pageSize.width,
      height: pageSize.height,
      color: PDFLib.rgb(1, 1, 1),
    });
    page.drawImage(embedded, {
      ...placement,
    });

    const effectiveDpi = Math.min(
      image.width / (placement.width / POINTS_PER_INCH),
      image.height / (placement.height / POINTS_PER_INCH)
    );
    if (onPageProcessed) {
      onPageProcessed({
        index,
        name,
        width: image.width,
        height: image.height,
        effectiveDpi,
      });
    }
  }

  return pdfDoc.save();
}
