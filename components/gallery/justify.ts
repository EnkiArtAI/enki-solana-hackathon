/**
 * Justified rows (Kev, 2026-10-14): every row spans the full width, the images
 * in a row share one height, and that height varies from row to row. Each
 * image contributes its aspect ratio (width / height); a row is cut once the
 * images at the target height would fill the width, then the row's height is
 * whatever makes them fit exactly. The last row keeps the target height and
 * stays short rather than stretching tall.
 */
export type JustifiedRow<T> = { items: T[]; height: number };

export function justifyRows<T extends { ratio: number }>(items: T[], width: number, target: number, gap: number): JustifiedRow<T>[] {
  const rows: JustifiedRow<T>[] = [];
  if (width <= 0 || target <= 0) return rows;
  let row: T[] = [];
  let ratios = 0;
  for (const item of items) {
    row.push(item);
    ratios += item.ratio;
    const gaps = gap * (row.length - 1);
    if (ratios * target >= width - gaps) {
      rows.push({ items: row, height: (width - gaps) / ratios });
      row = [];
      ratios = 0;
    }
  }
  if (row.length) {
    const gaps = gap * (row.length - 1);
    // A short last row at the target height; a nearly full one is justified like the others.
    const fitted = (width - gaps) / ratios;
    rows.push({ items: row, height: fitted <= target * 1.25 ? fitted : target });
  }
  return rows;
}

/** The row height the profile's wall aims for, about 300 px, 180 below 900 px of width; its rows stand 2 px apart. */
export const ROW_GAP = 2;
export const rowTarget = (width: number) => (width < 900 ? 180 : 300);
