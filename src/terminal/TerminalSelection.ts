import type { TerminalSnapshot } from './contracts.js';

type Point = { x: number; y: number };

/** Keep the displayed text stable while the child continues producing output. */
export class TerminalSelection {
  public dragging = true;
  private readonly _anchor: Point;
  private _end: Point;

  public constructor(
    public readonly snapshot: TerminalSnapshot,
    public readonly cols: number,
    public readonly rows: number,
    x: number,
    y: number,
  ) {
    this._anchor = this._point(x, y);
    this._end = this._anchor;
  }

  public get empty(): boolean {
    return this._anchor.x === this._end.x && this._anchor.y === this._end.y;
  }

  public get text(): string {
    if (this.empty) {
      return '';
    }

    const [start, end] = this._range();
    let text = '';
    for (let y = start.y; y <= end.y; y++) {
      const part = this._lineText(y);
      const wrapped = y < end.y && this.snapshot.wrapped?.[y + 1];

      text += wrapped ? part : part.trimEnd();
      if (y < end.y && !wrapped) {
        text += '\n';
      }
    }

    return text;
  }

  public move(x: number, y: number): void {
    this._end = this._point(x, y);
  }

  public contains(x: number, y: number): boolean {
    if (this.empty) {
      return false;
    }

    const [start, end] = this._range();
    const lastWidth = this.snapshot.lines[end.y]?.[end.x]?.width ?? 1;

    return (
      y >= start.y &&
      y <= end.y &&
      (y !== start.y || x >= start.x) &&
      (y !== end.y || x < end.x + lastWidth)
    );
  }

  private _lineText(y: number): string {
    const line = this.snapshot.lines[y] ?? [];
    let text = '';
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (cell?.width && this.contains(x, y) && !this._wrapPadding(x, y)) {
        text += cell.text;
      }
    }

    return text;
  }

  private _point(x: number, y: number): Point {
    y = Math.max(0, Math.min(this.rows - 1, y));
    x = Math.max(0, Math.min(this.cols - 1, x));
    if (x > 0 && this.snapshot.lines[y]?.[x]?.width === 0) {
      x--;
    }

    return { x, y };
  }

  private _range(): [Point, Point] {
    const a = this._anchor,
      b = this._end;

    return a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a];
  }

  private _wrapPadding(x: number, y: number): boolean {
    return (
      x === this.cols - 1 &&
      this.snapshot.lines[y]?.[x]?.text === ' ' &&
      Boolean(this.snapshot.wrapped?.[y + 1]) &&
      this.snapshot.lines[y + 1]?.[0]?.width === 2
    );
  }
}
