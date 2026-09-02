import { readImageForPdf } from './image-io.js?v=20260901-1';
import {
  buildDirectImagePdf,
  parseDirectJpeg,
  parseDirectRgbPng,
} from './fast-png-pdf.js?v=20260902-1';
import { layoutOcrWords } from './text-layer.js?v=20260902-1';
import { runPool } from './pool.js?v=20260901-1';

// TPT worksheets are produced as US Letter pages. Images are embedded without
// re-encoding on the fast path; only the draw rectangle changes.
export const LETTER_WIDTH = 612;
export const LETTER_HEIGHT = 792;
export const DEFAULT_SQUARE_COVER_COUNT = 3;
export const DEFAULT_PAGE_NUMBERS_ENABLED = false;
// Searchable text is opt-in: OCR is slower than plain image assembly and the
// image-only output is what most books need.
export const DEFAULT_SEARCHABLE_TEXT_ENABLED = false;
export const DEFAULT_OCR_LANGUAGE = 'eng';
export const PAGE_NUMBER_FONT_SIZE = 12.5;

// Covers carry stylized marketing type that OCR reads poorly and that nobody
// searches for, so only interior pages get a text layer.
export function shouldOcrPage(pageIndex, squareCoverCount = DEFAULT_SQUARE_COVER_COUNT) {
  const normalizedCount = Math.max(0, Math.floor(Number(squareCoverCount) || 0));
  return pageIndex >= normalizedCount;
}

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
  };
}

// Writes one page's OCR words as PDF text rendering mode 3 (invisible) using
// raw content operators. pdf-lib has no render-mode option on drawText, and
// alpha-based "invisibility" would still be a painting operation.
function drawInvisibleTextLayer(page, PDFLib, items, font) {
  const { PDFOperator, PDFOperatorNames: Ops } = PDFLib;
  const fontKey = page.node.newFontDictionary('BinderyOcrText', font.ref);
  // pdf-lib sizes operator arguments with `arg.length`, so every numeric
  // operand must be handed over as a string. Passing raw numbers silently
  // produces an empty content stream instead of raising an error.
  const operators = [
    PDFOperator.of(Ops.PushGraphicsState),
    PDFOperator.of(Ops.BeginText),
    PDFOperator.of(Ops.SetTextRenderingMode, ['3']),
  ];
  let lastSize = null;
  let lastScale = null;
  for (const item of items) {
    if (item.size !== lastSize) {
      operators.push(PDFOperator.of(Ops.SetFontAndSize, [fontKey, String(item.size)]));
      lastSize = item.size;
    }
    if (item.horizontalScale !== lastScale) {
      operators.push(
        PDFOperator.of(Ops.SetTextHorizontalScaling, [String(item.horizontalScale)])
      );
      lastScale = item.horizontalScale;
    }
    operators.push(
      PDFOperator.of(Ops.SetTextMatrix, ['1', '0', '0', '1', String(item.x), String(item.y)])
    );
    operators.push(PDFOperator.of(Ops.ShowText, [font.encodeText(item.text)]));
  }
  operators.push(PDFOperator.of(Ops.EndText), PDFOperator.of(Ops.PopGraphicsState));
  page.pushOperators(...operators);
}

// Builds one PDF from a book's already-naturally-sorted image handles.
// Pages are read, decoded, and embedded one at a time. A book containing many
// large scans would otherwise keep every decoded bitmap in memory at once and
// can freeze the browser.
async function buildWithPdfLib(
  files,
  PDFLib,
  { compress, squareCoverCount, pageNumbersEnabled, ocrWordsByPage, onPageProcessed }
) {
  const pdfDoc = await PDFLib.PDFDocument.create();
  const hasNumberedPages = pageNumbersEnabled && files.length > squareCoverCount;
  const pageNumberFont = hasNumberedPages
    ? await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold)
    : null;
  const hasOcrWords = Array.isArray(ocrWordsByPage)
    && ocrWordsByPage.some((words) => words && words.length > 0);
  // Helvetica with WinAnsiEncoding is what the direct engine uses too, so the
  // invisible layer is byte-for-byte comparable between the two paths.
  const textLayerFont = hasOcrWords
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
      layout.pageHeight
    );
    page.drawImage(embedded, placement);

    // Invisible OCR text is pushed after the image and before the page number
    // so the image stays untouched and copied sentences keep their order.
    const textLayerItems = textLayerFont
      ? layoutOcrWords(ocrWordsByPage?.[pageIndex] || [], {
          imageWidth: image.width,
          imageHeight: image.height,
          placement,
        })
      : [];
    if (textLayerItems.length > 0) {
      drawInvisibleTextLayer(page, PDFLib, textLayerItems, textLayerFont);
    }

    if (layout.pageNumber !== null) {
      const pageNumberText = String(layout.pageNumber);
      const textWidth = pageNumberFont.widthOfTextAtSize(pageNumberText, PAGE_NUMBER_FONT_SIZE);
      const badgeWidth = Math.max(20, textWidth + 8);
      page.drawEllipse({
        x: layout.pageWidth / 2,
        y: 9,
        xScale: badgeWidth / 2,
        yScale: 8,
        color: PDFLib.rgb(1, 1, 1),
        borderColor: PDFLib.rgb(0.18, 0.18, 0.2),
        borderWidth: 0.8,
      });
      page.drawText(pageNumberText, {
        x: (layout.pageWidth - textWidth) / 2,
        y: 4.5,
        size: PAGE_NUMBER_FONT_SIZE,
        font: pageNumberFont,
        color: PDFLib.rgb(0.1, 0.1, 0.12),
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
      textLayerWordCount: textLayerItems.length,
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
    searchableText = DEFAULT_SEARCHABLE_TEXT_ENABLED,
    recognizeWords = null,
    ocrConcurrency = 1,
    onOcrProgress = null,
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

  // OCR phase. Runs strictly before assembly, one page at a time, so memory
  // stays flat and progress can be reported honestly. With searchable text off
  // (the default) nothing here executes and no OCR code is even reachable.
  const ocrWordsByPage = new Array(files.length).fill(null);
  if (searchableText && typeof recognizeWords === 'function' && files.length > 0) {
    const ocrPageIndexes = [];
    for (let pageIndex = 0; pageIndex < files.length; pageIndex += 1) {
      if (shouldOcrPage(pageIndex, normalizedSquareCoverCount)) ocrPageIndexes.push(pageIndex);
    }
    const total = ocrPageIndexes.length;
    // Recognition is the slow part and it is CPU-bound, so a few pages run at
    // once. Results are stored by page index, so the page order of the finished
    // PDF does not depend on which page happens to finish first. Concurrency is
    // capped by the caller, which bounds how many decoded pages are in memory.
    const lanes = Math.max(1, Math.min(Math.floor(Number(ocrConcurrency) || 1), total));
    let completed = 0;
    const results = await runPool(ocrPageIndexes, lanes, async (pageIndex) => {
      const { file, name } = files[pageIndex];
      const recognized = await recognizeWords(file, { pageIndex, name, completed, total });
      ocrWordsByPage[pageIndex] = Array.isArray(recognized)
        ? recognized
        : (recognized && recognized.words) || [];
      completed += 1;
      onOcrProgress?.({ phase: 'ocr', pageIndex, name, completed, total });
    });
    // runPool isolates failures so one bad page cannot abandon the others
    // mid-flight; surface the first one so the book fails honestly.
    const failure = results.find((result) => result && result.ok === false);
    if (failure) throw failure.error;
    if (total > 0) {
      onOcrProgress?.({
        phase: 'assemble',
        pageIndex: files.length - 1,
        name: files[files.length - 1].name,
        completed: total,
        total,
      });
    }
  }
  const hasOcrWords = ocrWordsByPage.some((words) => words && words.length > 0);

  if (canUseDirect && directImages.length === imageHandles.length) {
    // Text-layer geometry is derived from the same layout/placement functions
    // the engine itself uses, so the invisible text can never disagree with
    // where the image was actually drawn.
    const directTextLayers = directImages.map((image, index) => {
      const words = ocrWordsByPage[index];
      if (!words || words.length === 0) return [];
      const layout = getPageLayout(
        image.name,
        image.width,
        image.height,
        index,
        normalizedSquareCoverCount,
        pageNumbersEnabled
      );
      const placement = getImagePlacement(
        image.width,
        image.height,
        layout.fillPage,
        layout.pageWidth,
        layout.pageHeight
      );
      return layoutOcrWords(words, {
        imageWidth: image.width,
        imageHeight: image.height,
        placement,
      });
    });

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
          pageSize.height
        );
      },
      pageNumberForPage: (_image, index) =>
        getPageNumber(index, normalizedSquareCoverCount, pageNumbersEnabled),
      textLayerForPage: hasOcrWords ? (_image, index) => directTextLayers[index] : null,
      title,
      onPageProcessed,
    });
  }

  return buildWithPdfLib(files, PDFLib, {
    compress,
    squareCoverCount: normalizedSquareCoverCount,
    pageNumbersEnabled,
    ocrWordsByPage: hasOcrWords ? ocrWordsByPage : null,
    onPageProcessed,
  });
}
