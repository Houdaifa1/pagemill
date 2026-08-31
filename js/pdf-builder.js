import { readImageForPdf } from './image-io.js?v=20260830-3';

// Source pixel dimensions are treated as 300 DPI when converting to PDF
// points (72 points per inch) — see README for why this assumption was made
// and what it means for images with different embedded DPI.
const ASSUMED_DPI = 300;
const POINTS_PER_INCH = 72;

function pixelsToPoints(px) {
  return (px / ASSUMED_DPI) * POINTS_PER_INCH;
}

// Builds one PDF from a book's already-naturally-sorted image handles.
// Pages are read, decoded, and embedded one at a time. A book containing many
// large scans would otherwise keep every decoded bitmap in memory at once and
// can freeze the browser.
export async function buildBookPdf(imageHandles, PDFLib, { compress = false } = {}) {
  const pdfDoc = await PDFLib.PDFDocument.create();

  for (const { handle } of imageHandles) {
    const file = await handle.getFile();
    const image = await readImageForPdf(file, { compress });
    const embedded =
      image.type === 'png'
        ? await pdfDoc.embedPng(image.bytes)
        : await pdfDoc.embedJpg(image.bytes);

    const pageWidth = pixelsToPoints(image.width);
    const pageHeight = pixelsToPoints(image.height);
    const page = pdfDoc.addPage([pageWidth, pageHeight]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: pageWidth,
      height: pageHeight,
    });
  }

  return pdfDoc.save();
}
