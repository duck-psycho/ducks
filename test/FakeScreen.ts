import { defined } from '../src/defined.js';
import { MODES } from './helpers.js';
import type {
  CellStyle,
  TerminalModes,
  TerminalScreen,
  TerminalSnapshot,
  TerminalTextPosition,
} from '../src/terminal/contracts.js';
export class FakeScreen implements TerminalScreen {
  public title = '';
  public modes: TerminalModes = { ...MODES };
  public content = '';
  public offset = 0;
  public disposed = false;
  public constructor(
    public cols: number,
    public rows: number,
  ) {}
  public write(data: string, done?: () => void): void {
    this.content += data;
    done?.();
  }
  public resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  public scroll(lines: number): void {
    this.offset = Math.max(0, this.offset + lines);
  }
  public scrollToBottom(): void {
    this.offset = 0;
  }
  public onResponse(): void {
    /* Test stub. */
  }
  public snapshot(): TerminalSnapshot {
    const style: CellStyle = { fg: 0xcdd6f4, bg: 0x11111b };

    return {
      lines: this.content
        .split('\n')
        .map((line) =>
          Array.from(line).map((text) => ({ text, width: 1, style })),
        ),
      cursor: { x: 0, y: 0, visible: true },
      scrollOffset: this.offset,
    };
  }
  public text(): string {
    return this.snapshot()
      .lines.map((line) =>
        line
          .filter((cell) => cell.width > 0)
          .map((cell) => cell.text)
          .join('')
          .trimEnd(),
      )
      .join('\n');
  }
  public textAt(x: number, y: number): TerminalTextPosition | null {
    const line = this.snapshot().lines[y];
    if (!line?.[x]) {
      return null;
    }

    let index = 0;
    const cells = line.map((cell, col) => {
      const mapped = {
        x: col,
        y,
        width: cell.width,
        index,
        length: cell.text.length,
      };

      index += cell.text.length;

      return mapped;
    });

    return {
      text: line.map((cell) => cell.text).join(''),
      index: defined(cells[x]).index,
      cells,
    };
  }
  public dispose(): void {
    this.disposed = true;
  }
}
