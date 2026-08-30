// Returns the PDF filename Bindery may safely write. A filename recorded in a
// valid .done marker is Bindery-owned and can be overwritten. Otherwise every
// existing PDF is protected and a unique "- Bindery" name is selected.
export function chooseOutputPdfName(book) {
  if (book.generatedPdfName) return book.generatedPdfName;

  const existing = new Set((book.pdfNames || []).map((name) => name.toLowerCase()));
  if (existing.size === 0) return `${book.name}.pdf`;

  const base = `${book.name} - Bindery`;
  let candidate = `${base}.pdf`;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${base} ${suffix}.pdf`;
    suffix += 1;
  }
  return candidate;
}
