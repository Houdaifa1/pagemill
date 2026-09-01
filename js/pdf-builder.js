import { readImageForPdf } from './image-io.js?v=20260901-1';
import { buildDirectRgbPngPdf, parseDirectRgbPng } from './fast-png-pdf.js?v=20260901-2';

// TPT worksheets are produced as US Letter pages. Images are embedded without
// re-encoding on the fast path; only the draw rectangle changes.
export const LETTER_WIDTH = 612;
export const LETTER_HEIGHT = 792;

export function getImagePlacement(imageWidth, imageHeight, fillPage = false) {
  const scale = fillPage
    ? Math.max(LETTER_WIDTH / imageWidth, LETTER_HEIGHT / imageHeight)
    : Math.min(LETTER_WIDTH / imageWidth, LETTER_HEIGHT / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (LETTER_WIDTH - width) / 2,
    y: (LETTER_HEIGHT - height) / 2,
    width,
    height,
  };
}

// Builds one PDF from a book's already-naturally-sorted image handles.
// Pages are read, decoded, and embedded one at a time. A book containing many
// large scans would otherwise keep every decoded bitmap in memory at once and
// can freeze the browser.
async function buildWithPdfLib(files, PDFLib, { compress, onPageProcessed }) {
  const pdfDoc = await PDFLib.PDFDocument.create();

  for (let pageIndex = 0; pageIndex < files.length; pageIndex += 1) {
    const { file, name } = files[pageIndex];
    const image = await readImageForPdf(file, { compress });
    const embedded =
      image.type === 'png'
        ? await pdfDoc.embedPng(image.bytes)
        : await pdfDoc.embedJpg(image.bytes);

    const page = pdfDoc.addPage([LETTER_WIDTH, LETTER_HEIGHT]);
    // The first naturally sorted image is the cover. Fill the entire sheet and
    // crop a small, centered amount when its aspect ratio differs from Letter,
    // eliminating white bars. Interior pages use contain so worksheet content
    // is never cut off.
    const placement = getImagePlacement(image.width, image.height, pageIndex === 0);
    page.drawImage(embedded, placement);
    onPageProcessed?.({ pageIndex, name, width: image.width, height: image.height, placement });
  }

  return pdfDoc.save();
}

// Builds a PDF from naturally sorted image handles. Standard 8-bit RGB PNGs
// use their already-compressed scanline data directly, avoiding the expensive
// PNG decode/recompress cycle. Any unusual PNG or JPEG falls back to pdf-lib.
export async function buildBookPdf(
  imageHandles,
  PDFLib,
  { compress = false, title = 'Bindery PDF', onPageProcessed = null } = {}
) {
  const files = [];
  const directImages = [];
  let canUseDirectPng = !compress && imageHandles.length > 0;

  for (const { handle, name } of imageHandles) {
    const file = await handle.getFile();
    files.push({ file, name });
    if (!canUseDirectPng) continue;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = parseDirectRgbPng(bytes, name);
    if (!parsed.supported) {
      canUseDirectPng = false;
      directImages.length = 0;
    } else {
      directImages.push({ ...parsed, name });
    }
  }

  if (canUseDirectPng && directImages.length === imageHandles.length) {
    return buildDirectRgbPngPdf(directImages, {
      pageWidth: LETTER_WIDTH,
      pageHeight: LETTER_HEIGHT,
      placementForPage: (width, height, index) => getImagePlacement(width, height, index === 0),
      title,
      onPageProcessed,
    });
  }

  return buildWithPdfLib(files, PDFLib, { compress, onPageProcessed });
}
