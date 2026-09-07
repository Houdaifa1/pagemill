import assert from 'node:assert/strict';
import { orderPagesForBook, DEFAULT_COVERS_AT_END } from '../js/page-order.js';

const names = (list) => list.map((item) => item.name);
const book = (...fileNames) => fileNames.map((name) => ({ name }));

// The real-world case: interiors downloaded first, then cover, thumb1, thumb2.
const realBook = book(
  'page-01.jpg', 'page-02.jpg', 'page-03.jpg', 'page-10.jpg',
  'cover.jpg', 'thumb1.jpg', 'thumb2.jpg'
);

const ordered = orderPagesForBook(realBook, { coversAtEnd: true, squareCoverCount: 3 });
assert.deepEqual(
  names(ordered),
  ['cover.jpg', 'thumb1.jpg', 'thumb2.jpg', 'page-01.jpg', 'page-02.jpg', 'page-03.jpg', 'page-10.jpg'],
  'the trailing cover and thumbnails move to the front, keeping their order'
);
assert.equal(names(ordered)[0], 'cover.jpg', 'the cover becomes page 1');
assert.equal(ordered.length, realBook.length, 'no page is lost or duplicated');
assert.deepEqual(
  [...names(ordered)].sort(),
  [...names(realBook)].sort(),
  'the reordered book contains exactly the same pages'
);

// The input array must not be mutated: books are re-rendered from it and a
// second build must start from the same on-disk order, not a rotated copy.
assert.deepEqual(
  names(realBook),
  ['page-01.jpg', 'page-02.jpg', 'page-03.jpg', 'page-10.jpg', 'cover.jpg', 'thumb1.jpg', 'thumb2.jpg'],
  'the original list is left untouched'
);
const twice = orderPagesForBook(
  orderPagesForBook(realBook, { coversAtEnd: true, squareCoverCount: 3 }),
  { coversAtEnd: true, squareCoverCount: 3 }
);
assert.notDeepEqual(names(twice), names(ordered), 'rotation is applied to the source order, not compounded silently');

// Switched off: the folder order is used exactly as-is.
assert.deepEqual(
  names(orderPagesForBook(realBook, { coversAtEnd: false, squareCoverCount: 3 })),
  names(realBook),
  'with the toggle off the natural sort order is preserved'
);

// A different cover count follows the square-cover setting.
assert.deepEqual(
  names(orderPagesForBook(realBook, { coversAtEnd: true, squareCoverCount: 1 })),
  ['thumb2.jpg', 'page-01.jpg', 'page-02.jpg', 'page-03.jpg', 'page-10.jpg', 'cover.jpg', 'thumb1.jpg'],
  'a count of 1 moves only the single last image'
);

// Zero covers means there is nothing to move.
assert.deepEqual(
  names(orderPagesForBook(realBook, { coversAtEnd: true, squareCoverCount: 0 })),
  names(realBook),
  'a square cover count of 0 leaves the order alone'
);

// Degenerate counts must not corrupt a book.
for (const bad of [-2, Number.NaN, undefined, null, '3']) {
  const result = orderPagesForBook(realBook, { coversAtEnd: true, squareCoverCount: bad });
  assert.equal(result.length, realBook.length, `count ${String(bad)} keeps every page`);
  assert.deepEqual([...names(result)].sort(), [...names(realBook)].sort(), `count ${String(bad)} loses no page`);
}
assert.deepEqual(
  names(orderPagesForBook(realBook, { coversAtEnd: true, squareCoverCount: '3' })),
  names(ordered),
  'a numeric string count behaves like the number'
);

// A book with no interior pages, or fewer pages than covers, is a no-op.
const coversOnly = book('cover.jpg', 'thumb1.jpg', 'thumb2.jpg');
assert.deepEqual(
  names(orderPagesForBook(coversOnly, { coversAtEnd: true, squareCoverCount: 3 })),
  names(coversOnly),
  'a book that is only covers keeps its order'
);
const tooFew = book('cover.jpg', 'thumb1.jpg');
assert.deepEqual(
  names(orderPagesForBook(tooFew, { coversAtEnd: true, squareCoverCount: 3 })),
  names(tooFew),
  'a book with fewer pages than the cover count keeps its order'
);
assert.deepEqual(orderPagesForBook([], { coversAtEnd: true, squareCoverCount: 3 }), [], 'an empty book stays empty');

// Defaults
assert.equal(DEFAULT_COVERS_AT_END, true, 'covers-at-end is on by default');
assert.deepEqual(
  names(orderPagesForBook(realBook, { squareCoverCount: 3 })),
  names(ordered),
  'the default applies the rotation without being asked'
);

console.log('Page order QA passed: trailing cover/thumbnails rotate to the front, cover becomes page 1,');
console.log('no page lost or duplicated, source list untouched, toggle off preserves order, edges safe.');
