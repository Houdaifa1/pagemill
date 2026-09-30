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

// In a shared result folder, unrelated PDFs should not change every book's
// name. Only a name collision adds a number.
export function chooseFlatOutputPdfName(bookName, pdfNames) {
  const existing = new Set([...pdfNames].map((name) => name.toLowerCase()));
  let candidate = `${bookName}.pdf`;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${bookName} - ${suffix}.pdf`;
    suffix += 1;
  }
  return candidate;
}

export function isSafePdfName(name) {
  return typeof name === 'string' && name.length > 4 &&
    /\.pdf$/i.test(name) && !/[\\/]/.test(name);
}

export function choosePreviewPdfName(pdfName, pdfNames, ownedName = null) {
  if (isSafePdfName(ownedName) && ownedName.toLowerCase() !== pdfName.toLowerCase()) {
    return ownedName;
  }
  const existing = new Set(pdfNames.map((name) => name.toLowerCase()));
  const base = pdfName.replace(/\.pdf$/i, '') + ' - Preview';
  let candidate = `${base}.pdf`;
  let suffix = 2;
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${base} ${suffix}.pdf`;
    suffix += 1;
  }
  return candidate;
}
