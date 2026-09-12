// Tomo grid cell ordering: boustrophedon (snake), top-down.
// Row 0 is the TOP row, captured left-to-right; row 1 right-to-left, etc.
// This matches the rover's natural top-down traverse for a 2D aperture scan.

export function tomoGridCell(index, xCount, yCount) {
  const h = Math.max(1, xCount);
  const iy = Math.floor(index / h);
  const along = index % h;
  const ix = iy % 2 === 0 ? along : h - 1 - along;
  return { ix, iy };
}

export function tomoGridStats(xCount, yCount, xStep, yStep) {
  const total = Math.max(1, xCount) * Math.max(1, yCount);
  const width = xStep * (Math.max(1, xCount) - 1);
  const height = yStep * (Math.max(1, yCount) - 1);
  return { total, width, height };
}

export function tomoRowProgress(capturedCount, xCount, yCount) {
  const h = Math.max(1, xCount);
  const currentRow = Math.floor(capturedCount / h);
  const inRow = capturedCount % h;
  return { currentRow, inRow, totalRows: Math.max(1, yCount) };
}
