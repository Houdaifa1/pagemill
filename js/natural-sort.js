// True natural-order comparator: splits into runs of digits vs non-digits
// so "page2.png" sorts before "page10.png" instead of after.
export function naturalCompare(a, b) {
  const ax = String(a).match(/(\d+|\D+)/g) || [];
  const bx = String(b).match(/(\d+|\D+)/g) || [];
  const len = Math.max(ax.length, bx.length);

  for (let i = 0; i < len; i++) {
    const chunkA = ax[i];
    const chunkB = bx[i];
    if (chunkA === undefined) return -1;
    if (chunkB === undefined) return 1;

    const numA = /^\d+$/.test(chunkA) ? Number(chunkA) : null;
    const numB = /^\d+$/.test(chunkB) ? Number(chunkB) : null;

    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA - numB;
      // equal numeric value but different string (e.g. "01" vs "1") — fall
      // back to string compare of this chunk before moving on
      if (chunkA !== chunkB) return chunkA < chunkB ? -1 : 1;
    } else if (chunkA !== chunkB) {
      return chunkA < chunkB ? -1 : 1;
    }
  }
  return 0;
}
