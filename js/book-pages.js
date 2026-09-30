import { orderPagesForBook } from './page-order.js?v=20260907-1';

// Skip mode uses the folder's image order. It has no cover pages, so page
// layout, OCR, numbering, and preview selection all start from the same page.
export function prepareBookPages(imageHandles, {
  coversAtEnd,
  squareCoverCount,
  excludeFirstPages = false,
  excludedPageCount = 4,
}) {
  const ordered = orderPagesForBook(imageHandles, {
    coversAtEnd: excludeFirstPages ? false : coversAtEnd,
    squareCoverCount: excludeFirstPages ? 0 : squareCoverCount,
  });
  const removed = excludeFirstPages
    ? Math.max(0, Math.floor(Number(excludedPageCount) || 0))
    : 0;
  if (removed >= ordered.length) {
    throw new Error(`No pages remain after skipping ${removed} of ${ordered.length} images. Lower the skip count for this book.`);
  }
  return {
    images: ordered.slice(removed),
    coverCount: excludeFirstPages ? 0 : squareCoverCount,
    removed,
  };
}
