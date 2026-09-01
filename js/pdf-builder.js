import { readImageForPdf } from './image-io.js?v=20260901-1';
import {
  buildDirectImagePdf,
  parseDirectJpeg,
  parseDirectRgbPng,
} from './fast-png-pdf.js?v=20260901-4';

// TPT worksheets are produced as US Letter pages. Images are embedded without
// re-encoding on the fast path; only the draw rectangle changes.
export const LETTER_WIDTH = 612;
export const LETTER_HEIGHT = 792;
export const DEFAULT_SQUARE_COVER_COUNT = 3;

export function getImagePlacement(
  imageWidth,
  imageHeight,
  fillPage = false,
  pageWidth = LETTER_WIDTH,
  pageHeight = LETTER_HEIGHT
) {
  const scale = fillPage
    ? Math.max(pageWidth / imageWidth, pageHeight / imageHeight)
    : Math.min(pageWidth / imageWidth, pageHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  };
}

// The user explicitly chooses how many leading marketplace covers/thumbnails
// are square. Covers use an 8.5 x 8.5-inch PDF page; interiors use US Letter.
// All images are contained, never cropped, so a mistaken count is recoverable.
export function getPageLayout(
  name,
  imageWidth,
  imageHeight,
  pageIndex,
  squareCoverCount = DEFAULT_SQUARE_COVER_COUNT
) {
  const normalizedCount = Math.max(0, Math.floor(Number(squareCoverCount) || 0));
  const squareCover = pageIndex < normalizedCount;
  return {
    pageWidth: LETTER_WIDTH,
    pageHeight: squareCover ? LETTER_WIDTH : LETTER_HEIGHT,
    fillPage: false,
    kind: squareCover ? 'square-cover' : 'interior',
  };
}

// Builds one PDF from a book's already-naturally-sorted image handles.
// Pages are read, decoded, and embedded one at a time. A book containing many
// large scans would otherwise keep every decoded bitmap in memory at once and
// can freeze the browser.
async function buildWithPdfLib(files, PDFLib, { compress, squareCoverCount, onPageProcessed }) {
  const pdfDoc = await PDFLib.PDFDocument.create();

  for (let pageIndex = 0; pageIndex < files.length; pageIndex += 1) {
    const { file, name } = files[pageIndex];
    const image = await readImageForPdf(file, { compress });
    const embedded =
      image.type === 'png'
        ? await pdfDoc.embedPng(image.bytes)
        : await pdfDoc.embedJpg(image.bytes);

    const layout = getPageLayout(name, image.width, image.height, pageIndex, squareCoverCount);
    const page = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);
    const placement = getImagePlacement(
      image.width,
      image.height,
      layout.fillPage,
      layout.pageWidth,
      layout.pageHeight
    );
    page.drawImage(embedded, placement);
    onPageProcessed?.({
      pageIndex,
      name,
      width: image.width,
      height: image.height,
      pageWidth: layout.pageWidth,
      pageHeight: layout.pageHeight,
      pageKind: layout.kind,
      placement,
    });
  }

  return pdfDoc.save();
}

// Builds a PDF from naturally sorted image handles. Standard 8-bit RGB PNGs
// and 8-bit grayscale/RGB JPEGs are copied directly into the PDF without
// decoding or re-encoding. Only unusual formats use the pdf-lib fallback.
export async function buildBookPdf(
  imageHandles,
  PDFLib,
  {
    compress = false,
    title = 'Bindery PDF',
    squareCoverCount = DEFAULT_SQUARE_COVER_COUNT,
    onPageProcessed = null,
  } = {}
) {
  const normalizedSquareCoverCount = Math.max(
    0,
    Math.floor(Number(squareCoverCount) || 0)
  );
  const files = [];
  const directImages = [];
  let canUseDirect = !compress && imageHandles.length > 0;

  for (const { handle, name } of imageHandles) {
    const file = await handle.getFile();
    files.push({ file, name });
    if (!canUseDirect) continue;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed =
      bytes[0] === 0xff && bytes[1] === 0xd8
        ? parseDirectJpeg(bytes, name)
        : parseDirectRgbPng(bytes, name);
    if (!parsed.supported) {
      canUseDirect = false;
      directImages.length = 0;
    } else {
      directImages.push({ ...parsed, name });
    }
  }

  if (canUseDirect && directImages.length === imageHandles.length) {
    return buildDirectImagePdf(directImages, {
      pageWidth: LETTER_WIDTH,
      pageHeight: LETTER_HEIGHT,
      pageSizeForPage: (image, index) => {
        const layout = getPageLayout(
          image.name,
          image.width,
          image.height,
          index,
          normalizedSquareCoverCount
        );
        return { width: layout.pageWidth, height: layout.pageHeight, kind: layout.kind };
      },
      placementForPage: (width, height, index, pageSize) => {
        const layout = getPageLayout(
          directImages[index].name,
          width,
          height,
          index,
          normalizedSquareCoverCount
        );
        return getImagePlacement(width, height, layout.fillPage, pageSize.width, pageSize.height);
      },
      title,
      onPageProcessed,
    });
  }

  return buildWithPdfLib(files, PDFLib, {
    compress,
    squareCoverCount: normalizedSquareCoverCount,
    onPageProcessed,
  });
}
