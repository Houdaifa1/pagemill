import { orderPagesForBook } from './page-order.js?v=20260907-1';

// Cover ordering happens first. Removing pages then updates the number of
// covers that remain, so OCR, page numbering, layout, and previews agree.
export function prepareBookPages(imageHandles, {
  coversAtEnd,
  squareCoverCount,
  excludeFirstPages = false,
  excludedPageCount = 4,
}) {
  const ordered = orderPagesForBook(imageHandles, { coversAtEnd, squareCoverCount });
  const removed = excludeFirstPages
    ? Math.max(0, Math.floor(Number(excludedPageCount) || 0))
    : 0;
  if (removed >= ordered.length) {
    throw new Error(`No pages remain after skipping ${removed} of ${ordered.length} images. Lower the skip count for this book.`);
  }
  return {
    images: ordered.slice(removed),
    coverCount: Math.max(0, squareCoverCount - removed),
    removed,
  };
}
