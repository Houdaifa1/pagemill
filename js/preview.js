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
  pages.forEach((page) => preview.addPage(page));
  return preview.save();
}
