// Marketplace images (the cover and its thumbnails) are often downloaded after
// the interior pages, so natural sort leaves them at the END of a book folder:
//
//   page-01 … page-30, cover, thumb1, thumb2
//
// Everything downstream — square cover pages, page numbering, and skipping
// covers during OCR — keys off a page's index, expecting those images first.
// Rather than teach each of those about a second layout (or make the user
// rename files by hand), the ordered page list is rotated once here, at the
// single point where a book's reading order is decided.
//
//   cover, thumb1, thumb2, page-01 … page-30
//
// The trailing images keep their relative order, so the cover stays page 1.
export const DEFAULT_COVERS_AT_END = true;

export function orderPagesForBook(imageHandles, {
  coversAtEnd = DEFAULT_COVERS_AT_END,
  squareCoverCount = 0,
} = {}) {
  const count = Math.max(0, Math.floor(Number(squareCoverCount) || 0));
  if (!coversAtEnd || count === 0) return imageHandles.slice();

  // With `count` >= the page count, `slice(-count)` is the whole list and the
  // interior slice is empty, so a book made only of covers is left untouched.
  const covers = imageHandles.slice(-count);
  const interiors = imageHandles.slice(0, -count);
  return [...covers, ...interiors];
}
