const POINTS_PER_INCH = 72;

export const PAGE_FORMATS = {
  letter: { width: 8.5 * POINTS_PER_INCH, height: 11 * POINTS_PER_INCH },
};

function isPng(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

export function fitImageToPage(image, pageSize = PAGE_FORMATS.letter) {
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

// Fast PNG-only path: source bytes are embedded directly. pdf-lib supplies the
// pixel dimensions, so the browser never decodes or re-encodes the image.
export async function buildBookPdf(
  pngHandles,
  PDFLib,
  { title = 'Bindery PDF', onPageProcessed = null } = {}
) {
  if (pngHandles.length === 0) throw new Error('This folder contains no PNG pages.');

  const pageSize = PAGE_FORMATS.letter;
  const pdfDoc = await PDFLib.PDFDocument.create();
  pdfDoc.setTitle(title);
  pdfDoc.setSubject('US Letter book assembled from naturally ordered PNG pages');
  pdfDoc.setCreator('Bindery');
  pdfDoc.setProducer('Bindery fast PNG engine');

  for (let index = 0; index < pngHandles.length; index++) {
    const { handle, name } = pngHandles[index];
    const file = await handle.getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!isPng(bytes)) throw new Error(`${name}: file extension is PNG but the file data is not a valid PNG.`);

    let embedded;
    try {
      embedded = await pdfDoc.embedPng(bytes);
    } catch (error) {
      throw new Error(`${name}: PNG cannot be embedded (${error?.message || 'invalid PNG'}).`);
    }

    const placement = fitImageToPage(embedded, pageSize);
    const page = pdfDoc.addPage([pageSize.width, pageSize.height]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: pageSize.width,
      height: pageSize.height,
      color: PDFLib.rgb(1, 1, 1),
    });
    page.drawImage(embedded, placement);

    onPageProcessed?.({
      index,
      name,
      width: embedded.width,
      height: embedded.height,
      placement,
      effectiveDpi: Math.min(
        embedded.width / (placement.width / POINTS_PER_INCH),
        embedded.height / (placement.height / POINTS_PER_INCH)
      ),
    });
  }

  return pdfDoc.save();
}
