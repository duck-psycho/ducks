import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from '../model.js';

export const SIDEBAR_WIDTH: number = DEFAULT_SIDEBAR_WIDTH;
const MIN_TERMINAL_WIDTH = 20;

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
  preferredSidebarWidth: number = SIDEBAR_WIDTH,
): { sidebar: Rect; terminal: Rect; tabs: Rect; small: boolean } {
  const sidebarWidth = Math.max(
    MIN_SIDEBAR_WIDTH,
    Math.min(preferredSidebarWidth, cols - MIN_TERMINAL_WIDTH - 2),
  );
  const terminalX = sidebarWidth + 1;

  return {
    small: cols < 80 || rows < 24,
    sidebar: { x: 0, y: 1, w: sidebarWidth, h: Math.max(0, rows - 3) },
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
