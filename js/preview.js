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
  const font = await preview.embedFont(PDFLib.StandardFonts.HelveticaBold);
  for (const page of pages) {
    preview.addPage(page);
    const { width, height } = page.getSize();
    const scale = Math.min(width / 612, height / 792);
    for (const y of [15, 235, 455]) {
      page.drawText('PREVIEW', {
        x: (width / 612) * 80,
        y: (height / 792) * y,
        size: 98 * scale,
        font,
        color: PDFLib.rgb(0.13, 0.18, 0.28),
        opacity: 0.24,
        rotate: PDFLib.degrees(32),
      });
    }
  }
  return preview.save();
}
