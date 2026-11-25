// Pick unique interior pages, then keep them in reading order in the preview.
export function selectPreviewPageIndexes(pageCount, coverCount, manualCount = null, random = Math.random) {
  const total = Math.max(0, Math.floor(Number(pageCount) || 0));
  const firstInterior = Math.min(total, Math.max(0, Math.floor(Number(coverCount) || 0)));
  const available = total - firstInterior;
  if (available === 0) return [];

  const requested = manualCount === null
    ? Math.max(3, Math.round(available * 0.1))
    : Math.max(1, Math.floor(Number(manualCount) || 1));
  const count = Math.min(available, requested);
  const indexes = Array.from({ length: available }, (_, index) => firstInterior + index);

  for (let index = 0; index < count; index += 1) {
    const offset = Math.min(available - index - 1, Math.floor(random() * (available - index)));
    const swapIndex = index + Math.max(0, offset);
    [indexes[index], indexes[swapIndex]] = [indexes[swapIndex], indexes[index]];
  }

  return indexes.slice(0, count).sort((a, b) => a - b);
}

export async function buildPreviewPdf(fullPdfBytes, pageIndexes, PDFLib) {
  if (pageIndexes.length === 0) return null;
  const fullPdf = await PDFLib.PDFDocument.load(fullPdfBytes);
  const preview = await PDFLib.PDFDocument.create();
  const pages = await preview.copyPages(fullPdf, pageIndexes);
  for (const page of pages) preview.addPage(page);
  await addPreviewWatermarks(preview, PDFLib);
  return preview.save();
}

export async function addPreviewWatermarks(preview, PDFLib, { overAnnotations = false } = {}) {
  const font = await preview.embedFont(PDFLib.StandardFonts.HelveticaBold);
  for (const page of preview.getPages()) {
    const box = page.getCropBox();
    const rotation = (page.getRotation().angle % 360 + 360) % 360;
    const sideways = rotation === 90 || rotation === 270;
    const width = sideways ? box.height : box.width;
    const height = sideways ? box.width : box.height;
    const scale = Math.min(width / 612, height / 792);
    const textOptions = [];
    for (const y of [15, 235, 455]) {
      const left = (width / 612) * 80;
      const bottom = (height / 792) * y;
      // Place the marks in the visible crop box and orient them as read.
      let x = box.x + left;
      let rawY = box.y + bottom;
      if (rotation === 90) [x, rawY] = [box.x + box.width - bottom, box.y + left];
      if (rotation === 180) [x, rawY] = [box.x + box.width - left, box.y + box.height - bottom];
      if (rotation === 270) [x, rawY] = [box.x + bottom, box.y + box.height - left];
      textOptions.push({
        x,
        y: rawY,
        size: 98 * scale,
        font,
        color: PDFLib.rgb(0.13, 0.18, 0.28),
        opacity: 0.24,
        rotate: PDFLib.degrees(32 + rotation),
      });
    }
    if (overAnnotations) {
      // Viewers paint form widgets after the page stream. Repeat the vector
      // overlay within their appearance boxes so it stays over opaque fields.
      const { context } = preview;
      const fontName = PDFLib.PDFName.of('PreviewFont');
      const state = PDFLib.PDFName.of('PreviewOpacity');
      const operators = textOptions.flatMap(({ rotate, ...options }) => PDFLib.drawText(font.encodeText('PREVIEW'), {
        ...options, font: fontName, graphicsState: state, rotate, xSkew: PDFLib.degrees(0), ySkew: PDFLib.degrees(0),
      }));
      const watermark = context.register(context.formXObject(operators, {
        BBox: [box.x, box.y, box.x + box.width, box.y + box.height],
        Resources: { Font: { PreviewFont: font.ref }, ExtGState: { PreviewOpacity: { Type: 'ExtGState', ca: 0.24 } } },
      }));
      const name = page.node.newXObject('Preview', watermark);
      page.pushOperators(PDFLib.drawObject(name));
      stampAnnotationAppearances(page, watermark, PDFLib);
    } else {
      for (const options of textOptions) page.drawText('PREVIEW', options);
    }
  }
}

function stampAnnotationAppearances(page, watermark, PDFLib) {
  const { PDFArray, PDFDict, PDFName, PDFStream, concatTransformationMatrix, drawObject,
    popGraphicsState, pushGraphicsState, translate } = PDFLib;
  const key = PDFName.of;
  const { context } = page.doc;
  for (const ref of page.node.Annots()?.asArray() || []) {
    const annotation = context.lookupMaybe(ref, PDFDict);
    const appearance = annotation?.lookupMaybe(key('AP'), PDFDict);
    const rect = annotation?.lookupMaybe(key('Rect'), PDFArray)?.asRectangle();
    if (!appearance || !rect || rect.width <= 0 || rect.height <= 0) continue;

    const wrap = (value) => {
      const stream = context.lookup(value);
      if (!(stream instanceof PDFStream)) return value;
      const bounds = stream.dict.lookupMaybe(key('BBox'), PDFArray)?.asRectangle();
      if (!bounds) return value;
      const matrix = stream.dict.lookupMaybe(key('Matrix'), PDFArray);
      const [a, b, c, d, e, f] = matrix?.asArray().map((number) => number.asNumber()) || [1, 0, 0, 1, 0, 0];
      const points = [bounds.x, bounds.x + bounds.width].flatMap((x) =>
        [bounds.y, bounds.y + bounds.height].map((y) => [a * x + c * y + e, b * x + d * y + f]));
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      const left = Math.min(...xs);
      const bottom = Math.min(...ys);
      const sx = rect.width / (Math.max(...xs) - left);
      const sy = rect.height / (Math.max(...ys) - bottom);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) return value;
      return context.register(context.formXObject([
        pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, -left * sx, -bottom * sy),
        drawObject('Original'), popGraphicsState(),
        pushGraphicsState(), translate(-rect.x, -rect.y), drawObject('Preview'), popGraphicsState(),
      ], {
        BBox: [0, 0, rect.width, rect.height],
        Resources: { XObject: { Original: context.getObjectRef(stream) || context.register(stream), Preview: watermark } },
      }));
    };

    const stamped = appearance.clone(context);
    for (const state of ['N', 'R', 'D'].map(key)) {
      const value = appearance.get(state);
      const states = context.lookup(value);
      if (states instanceof PDFDict) {
        const stampedStates = states.clone(context);
        for (const [name, stream] of states.entries()) stampedStates.set(name, wrap(stream));
        stamped.set(state, stampedStates);
      } else if (value) {
        stamped.set(state, wrap(value));
      }
    }
    annotation.set(key('AP'), stamped);
  }
}
