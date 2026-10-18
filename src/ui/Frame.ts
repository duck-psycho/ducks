import { defined } from '../defined.js';
import { DEFAULT_THEME } from '../themes.js';
import { cellWidth, graphemes } from './text.js';
import type { Rect } from './layout.js';
import type {
  CellStyle,
  TerminalCell,
  TerminalSnapshot,
} from '../terminal/contracts.js';
export class Frame {
  public static readonly BASE_STYLE: CellStyle = {
    fg: DEFAULT_THEME.colors.fg,
    bg: DEFAULT_THEME.colors.bg,
  };
  public readonly cells: TerminalCell[][];
  public constructor(
    public readonly cols: number,
    public readonly rows: number,
    private readonly _baseStyle: CellStyle = Frame.BASE_STYLE,
  ) {
    this.cells = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({
        text: ' ',
        width: 1,
        style: _baseStyle,
      })),
    );
  }
  public fill(rect: Rect, style: CellStyle): void {
    const start = Math.max(0, rect.x),
      end = Math.min(this.cols, rect.x + rect.w);
    if (end <= start) {
      return;
    }

    for (
      let y = Math.max(0, rect.y);
      y < Math.min(this.rows, rect.y + rect.h);
      y++
    ) {
      const row = defined(this.cells[y]);
      // An overlay may split a double-width glyph at either boundary.
      if (start > 0 && row[start]?.width === 0) {
        row[start - 1] = {
          text: ' ',
          width: 1,
          style: defined(row[start - 1]).style,
        };
      }

      if (end < this.cols && row[end]?.width === 0) {
        row[end] = { text: ' ', width: 1, style: row[end].style };
      }

      for (let x = start; x < end; x++) {
        row[x] = { text: ' ', width: 1, style };
      }
    }
  }
  public text(
    x: number,
    y: number,
    text: string,
    style: CellStyle = this._baseStyle,
    maxWidth: number = this.cols - x,
  ): void {
    if (y < 0 || y >= this.rows) {
      return;
    }

    const end = Math.min(this.cols, x + maxWidth);
    // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
    for (const g of graphemes(text.replace(/[\x00-\x1f\x7f]/gu, ' '))) {
      const width = cellWidth(g);
      if (x + width > end) {
        break;
      }

      if (width === 0 || x < 0) {
        continue;
      }

      defined(this.cells[y])[x] = { text: g, width, style };
      if (width === 2) {
        defined(this.cells[y])[x + 1] = { text: '', width: 0, style };
      }

      x += width;
    }
  }
  public terminal(
    rect: Rect,
    snapshot: TerminalSnapshot,
    focused: boolean,
  ): void {
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const source = snapshot.lines[y]?.[x];
        if (!source || !this.cells[rect.y + y]?.[rect.x + x]) {
          continue;
        }

        const cursor =
          focused &&
          snapshot.cursor.visible &&
          x === snapshot.cursor.x &&
          y === snapshot.cursor.y;

        defined(this.cells[rect.y + y])[rect.x + x] = cursor
          ? {
              ...source,
              style: { ...source.style, inverse: !source.style.inverse },
            }
          : source;
      }
    }
  }
  public runs(y: number): { text: string; style: CellStyle }[] {
    const result: { text: string; style: CellStyle }[] = [];
    for (const cell of this.cells[y] ?? []) {
      if (cell.width === 0) {
        continue;
      }

      const last = result.at(-1);
      if (last && sameStyle(last.style, cell.style)) {
        last.text += cell.text;
      } else {
        result.push({ text: cell.text, style: cell.style });
      }
    }

    return result;
  }
  public plainText(): string {
    return this.cells
      .map((row) =>
        row
          .filter((cell) => cell.width > 0)
          .map((cell) => cell.text)
          .join(''),
      )
      .join('\n');
  }
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return (
    a === b ||
    (a.fg === b.fg &&
      a.bg === b.bg &&
      Boolean(a.bold) === Boolean(b.bold) &&
      Boolean(a.dim) === Boolean(b.dim) &&
      Boolean(a.italic) === Boolean(b.italic) &&
      Boolean(a.underline) === Boolean(b.underline) &&
      Boolean(a.inverse) === Boolean(b.inverse) &&
      Boolean(a.strikethrough) === Boolean(b.strikethrough))
  );
}
