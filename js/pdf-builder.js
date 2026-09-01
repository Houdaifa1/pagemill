import { readImageForPdf } from './image-io.js?v=20260901-1';
import {
  buildDirectImagePdf,
  parseDirectJpeg,
  parseDirectRgbPng,
} from './fast-png-pdf.js?v=20260901-5';

// TPT worksheets are produced as US Letter pages. Images are embedded without
// re-encoding on the fast path; only the draw rectangle changes.
export const LETTER_WIDTH = 612;
export const LETTER_HEIGHT = 792;
export const DEFAULT_SQUARE_COVER_COUNT = 3;
export const DEFAULT_PAGE_NUMBERS_ENABLED = true;
export const PAGE_NUMBER_FOOTER_HEIGHT = 30;
export const PAGE_NUMBER_FONT_SIZE = 10;

export function getImagePlacement(
  imageWidth,
  imageHeight,
  fillPage = false,
  pageWidth = LETTER_WIDTH,
  pageHeight = LETTER_HEIGHT,
  safeBottom = 0
) {
  const normalizedSafeBottom = Math.max(0, Math.min(Number(safeBottom) || 0, pageHeight - 1));
  const availableHeight = pageHeight - normalizedSafeBottom;
  const scale = fillPage
    ? Math.max(pageWidth / imageWidth, availableHeight / imageHeight)
    : Math.min(pageWidth / imageWidth, availableHeight / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (pageWidth - width) / 2,
    y: normalizedSafeBottom + (availableHeight - height) / 2,
    width,
    height,
  };
}

export function getPageNumber(
  pageIndex,
  squareCoverCount = DEFAULT_SQUARE_COVER_COUNT,
  pageNumbersEnabled = DEFAULT_PAGE_NUMBERS_ENABLED
) {
  if (!pageNumbersEnabled) return null;
  const normalizedCount = Math.max(0, Math.floor(Number(squareCoverCount) || 0));
  return pageIndex < normalizedCount ? null : pageIndex - normalizedCount + 1;
}

// The user explicitly chooses how many leading marketplace covers/thumbnails
// are square. Covers use an 8.5 x 8.5-inch PDF page; interiors use US Letter.
// All images are contained, never cropped, so a mistaken count is recoverable.
export function getPageLayout(
  name,
  imageWidth,
  imageHeight,
  pageIndex,
  squareCoverCount = DEFAULT_SQUARE_COVER_COUNT,
  pageNumbersEnabled = DEFAULT_PAGE_NUMBERS_ENABLED
) {
  const normalizedCount = Math.max(0, Math.floor(Number(squareCoverCount) || 0));
  const squareCover = pageIndex < normalizedCount;
  const pageNumber = getPageNumber(pageIndex, normalizedCount, pageNumbersEnabled);
  return {
    pageWidth: LETTER_WIDTH,
    pageHeight: squareCover ? LETTER_WIDTH : LETTER_HEIGHT,
    fillPage: false,
    kind: squareCover ? 'square-cover' : 'interior',
    pageNumber,
    safeBottom: pageNumber === null ? 0 : PAGE_NUMBER_FOOTER_HEIGHT,
  };
}

// Builds one PDF from a book's already-naturally-sorted image handles.
// Pages are read, decoded, and embedded one at a time. A book containing many
// large scans would otherwise keep every decoded bitmap in memory at once and
// can freeze the browser.
async function buildWithPdfLib(
  files,
  PDFLib,
  { compress, squareCoverCount, pageNumbersEnabled, onPageProcessed }
) {
  const pdfDoc = await PDFLib.PDFDocument.create();
  const hasNumberedPages = pageNumbersEnabled && files.length > squareCoverCount;
  const pageNumberFont = hasNumberedPages
    ? await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica)
    : null;

  for (let pageIndex = 0; pageIndex < files.length; pageIndex += 1) {
    const { file, name } = files[pageIndex];
    const image = await readImageForPdf(file, { compress });
    const embedded =
      image.type === 'png'
        ? await pdfDoc.embedPng(image.bytes)
        : await pdfDoc.embedJpg(image.bytes);

    const layout = getPageLayout(
      name,
      image.width,
      image.height,
      pageIndex,
      squareCoverCount,
      pageNumbersEnabled
    );
    const page = pdfDoc.addPage([layout.pageWidth, layout.pageHeight]);
    const placement = getImagePlacement(
      image.width,
      image.height,
      layout.fillPage,
      layout.pageWidth,
      layout.pageHeight,
      layout.safeBottom
    );
    page.drawImage(embedded, placement);
    if (layout.pageNumber !== null) {
      const pageNumberText = String(layout.pageNumber);
      const textWidth = pageNumberFont.widthOfTextAtSize(pageNumberText, PAGE_NUMBER_FONT_SIZE);
      page.drawText(pageNumberText, {
        x: (layout.pageWidth - textWidth) / 2,
        y: 10,
        size: PAGE_NUMBER_FONT_SIZE,
        font: pageNumberFont,
        color: PDFLib.rgb(0.34, 0.34, 0.38),
      });
    }
    onPageProcessed?.({
      pageIndex,
      name,
      width: image.width,
      height: image.height,
      pageWidth: layout.pageWidth,
      pageHeight: layout.pageHeight,
      pageKind: layout.kind,
      placement,
      pageNumber: layout.pageNumber,
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
    pageNumbersEnabled = DEFAULT_PAGE_NUMBERS_ENABLED,
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
          normalizedSquareCoverCount,
          pageNumbersEnabled
        );
        return { width: layout.pageWidth, height: layout.pageHeight, kind: layout.kind };
      },
      placementForPage: (width, height, index, pageSize) => {
        const layout = getPageLayout(
          directImages[index].name,
          width,
          height,
          index,
          normalizedSquareCoverCount,
          pageNumbersEnabled
        );
        return getImagePlacement(
          width,
          height,
          layout.fillPage,
          pageSize.width,
          pageSize.height,
          layout.safeBottom
        );
      },
      pageNumberForPage: (_image, index) =>
        getPageNumber(index, normalizedSquareCoverCount, pageNumbersEnabled),
      title,
      onPageProcessed,
    });
  }

  return buildWithPdfLib(files, PDFLib, {
    compress,
    squareCoverCount: normalizedSquareCoverCount,
    pageNumbersEnabled,
    onPageProcessed,
  });
}
