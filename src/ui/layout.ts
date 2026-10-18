export const SIDEBAR_WIDTH = 40;

export type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export function inside(rect: Rect, x: number, y: number): boolean {
  return (
    x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h
  );
}

export function layout(
  cols: number,
  rows: number,
): { sidebar: Rect; terminal: Rect; tabs: Rect; small: boolean } {
  const terminalX = SIDEBAR_WIDTH + 1;

  return {
    small: cols < 80 || rows < 24,
    sidebar: { x: 0, y: 1, w: SIDEBAR_WIDTH, h: Math.max(0, rows - 3) },
    tabs: { x: terminalX, y: 0, w: Math.max(0, cols - terminalX), h: 1 },
    terminal: {
      x: terminalX,
      y: 1,
      w: Math.max(2, cols - terminalX - 1),
      h: Math.max(1, rows - 3),
    },
  };
}

export function promptWidth(cols: number): number {
  return Math.min(90, cols - 8);
}

export function searchVisibleRows(rows: number): number {
  return Math.max(1, Math.min(20, rows - 4) - 8);
}
