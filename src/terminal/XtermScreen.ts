import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import headless from '@xterm/headless';
import { defined } from '../defined.js';
import { DEFAULT_THEME } from '../themes.js';
import type {
  CellStyle,
  TerminalCell,
  TerminalModes,
  TerminalScreen,
  TerminalSnapshot,
  TerminalTextPosition,
} from './contracts.js';
import type { Theme } from '../themes.js';
import type { IBuffer, IBufferCell } from '@xterm/headless';

function paletteColor(index: number, theme: Theme): number {
  if (index < 16) {
    return theme.ansi[index] ?? theme.colors.fg;
  }

  if (index >= 232) {
    const v = 8 + (Math.min(index, 255) - 232) * 10;

    return (v << 16) | (v << 8) | v;
  }

  const n = index - 16;

  const channel = (v: number) => (v === 0 ? 0 : 55 + v * 40);

  return (
    (channel(Math.floor(n / 36)) << 16) |
    (channel(Math.floor(n / 6) % 6) << 8) |
    channel(n % 6)
  );
}

type SynchronizedDisplay = {
  snapshot: TerminalSnapshot;
  textRows: (TerminalTextPosition | null)[];
  timer: ReturnType<typeof setTimeout>;
};

export class XtermScreen implements TerminalScreen {
  public static readonly SYNCHRONIZED_OUTPUT_TIMEOUT_MS = 1000;
  public title = '';
  public progress = '';
  public mouseEncoding: 'sgr' | 'default' = 'default';
  private readonly _terminal: InstanceType<typeof headless.Terminal>;
  private _offset = 0;
  private _cursorVisible = true;
  private _disposed = false;
  private _lastBase = 0;
  private _alternateScroll = true;
  private _synchronized: SynchronizedDisplay | null = null;

  public constructor(
    cols: number,
    rows: number,
    private readonly _getTheme: () => Theme = () => DEFAULT_THEME,
    private readonly _writeHost: (data: string) => void = (data) => {
      process.stdout.write(data);
    },
  ) {
    this._terminal = new headless.Terminal({
      cols,
      rows,
      scrollback: 5000,
      allowProposedApi: true,
    });
    // The addon uses only the Unicode API shared by browser and headless xterm.
    this._terminal.loadAddon(new UnicodeGraphemesAddon());
    this._terminal.onTitleChange((title) => {
      this.title = title;
    });
    this._terminal.parser.registerOscHandler(9, (data) => {
      if (!/^4;[0-4](?:;\d{1,3})?$/u.test(data)) {
        return false;
      }

      this.progress = data;

      return true;
    });
    // Child applications (including Codex) copy through OSC 52. Headless
    // xterm has no clipboard, so relay writes to the actual host terminal.
    this._terminal.parser.registerOscHandler(52, (data) => {
      // Read queries need response routing; only relay clipboard writes.
      if (/^[cps0-7]*;[A-Za-z0-9+/]*={0,2}$/u.test(data)) {
        this._writeHost(`\x1b]52;${data}\x07`);
      }

      return true;
    });

    // Headless xterm parses OSC color requests but has no renderer to answer
    // them. Applications use these replies for contrast and animated RGB text.
    for (const command of [10, 11, 12]) {
      this._terminal.parser.registerOscHandler(command, (data) => {
        const queries = data.split(';');
        if (
          command + queries.length - 1 > 12 ||
          queries.some((query) => query !== '?')
        ) {
          return false;
        }

        const theme = this._getTheme();
        for (const index of queries.keys()) {
          this._reportColor(
            command + index,
            command + index === 11 ? theme.colors.bg : theme.colors.fg,
          );
        }

        return true;
      });
    }

    this._terminal.parser.registerOscHandler(4, (data) => {
      const parts = data.split(';');
      if (parts.length % 2) {
        return false;
      }

      for (let i = 0; i < parts.length; i += 2) {
        if (
          !/^\d{1,3}$/u.test(defined(parts[i])) ||
          Number(parts[i]) > 255 ||
          parts[i + 1] !== '?'
        ) {
          return false;
        }
      }

      const theme = this._getTheme();
      for (let i = 0; i < parts.length; i += 2) {
        const index = Number(parts[i]);
        this._reportColor(4, paletteColor(index, theme), index);
      }

      return true;
    });

    for (const final of ['h', 'l'] as const) {
      this._terminal.parser.registerCsiHandler(
        { prefix: '?', final },
        (params) => {
          if (params.includes(25)) {
            this._cursorVisible = final === 'h';
          }

          if (params.includes(1006)) {
            this.mouseEncoding = final === 'h' ? 'sgr' : 'default';
          }

          if (params.includes(1007)) {
            this._alternateScroll = final === 'h';
          }

          if (params.includes(2026)) {
            if (final === 'h') {
              this._beginSynchronizedOutput();
            } else {
              this._endSynchronizedOutput();
            }
          }

          return false;
        },
      );
    }

    this._terminal.parser.registerEscHandler({ final: 'c' }, () => {
      this.progress = '';
      this._endSynchronizedOutput();
      this._cursorVisible = true;
      this.mouseEncoding = 'default';
      this._alternateScroll = true;

      return false;
    });
  }

  public get cols(): number {
    return this._terminal.cols;
  }
  public get rows(): number {
    return this._terminal.rows;
  }
  public get modes(): TerminalModes {
    const m = this._terminal.modes;

    return {
      alternateScreen: this._terminal.buffer.active.type === 'alternate',
      alternateScroll: this._alternateScroll,
      applicationCursorKeys: m.applicationCursorKeysMode,
      bracketedPasteMode: m.bracketedPasteMode,
      sendFocus: m.sendFocusMode,
      mouseTrackingMode: m.mouseTrackingMode,
      mouseEncoding: this.mouseEncoding,
    };
  }
  public write(data: string, done?: () => void): void {
    if (this._disposed) {
      return;
    }

    this._terminal.write(data, () => {
      const base = this._terminal.buffer.active.baseY;
      if (this._offset) {
        this._offset += Math.max(0, base - this._lastBase);
      }

      this._lastBase = base;
      this._offset = Math.min(this._offset, base);
      done?.();
    });
  }
  public resize(cols: number, rows: number): void {
    if (!this._disposed) {
      this._endSynchronizedOutput();
      this._terminal.resize(cols, rows);
      this._lastBase = this._terminal.buffer.active.baseY;
      this._offset = Math.min(this._offset, this._lastBase);
    }
  }
  public scroll(lines: number): void {
    if (this._terminal.buffer.active.type === 'alternate') {
      return;
    }

    this._offset = Math.min(
      this._terminal.buffer.active.baseY,
      Math.max(0, this._offset + lines),
    );
  }
  public scrollToBottom(): void {
    this._offset = 0;
  }
  public onResponse(handler: (data: string) => void): void {
    this._response = handler;
    this._terminal.onData(handler);
  }

  public onRefresh(handler: () => void): void {
    this._refresh = handler;
  }

  public textAt(x: number, y: number): TerminalTextPosition | null {
    if (!this._synchronized) {
      return this._readTextAt(x, y);
    }

    if (outsideViewport(x, y, this.cols, this.rows)) {
      return null;
    }

    const position = this._synchronized.textRows[y];
    if (!position) {
      return null;
    }

    const cell = position.cells.find(
      (cell) => cell.y === y && cell.x <= x && cell.x + cell.width > x,
    );

    return {
      ...position,
      index:
        cell?.index ?? position.cells.find((cell) => cell.y === y)?.index ?? 0,
    };
  }

  public snapshot(
    live = false,
    theme: Theme = this._getTheme(),
  ): TerminalSnapshot {
    if (!live && this._synchronized) {
      return this._synchronized.snapshot;
    }

    return this._snapshot(live, theme);
  }

  public text(): string {
    const buffer = this._terminal.buffer.active;
    const cell = buffer.getNullCell();
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      const line = buffer.getLine(buffer.baseY + y);
      let text = '';
      for (let x = 0; x < this.cols; x++) {
        const source = line?.getCell(x, cell);
        if (source?.getWidth()) {
          text += cellText(source);
        }
      }

      lines.push(text.trimEnd());
    }

    return lines.join('\n');
  }

  public dispose(): void {
    if (!this._disposed) {
      this._disposed = true;
      if (this._synchronized) {
        clearTimeout(this._synchronized.timer);
      }

      this._synchronized = null;
      this._terminal.dispose();
    }
  }
  private _refresh: () => void = () => {
    /* No callback registered. */
  };
  private _response: (data: string) => void = () => {
    /* No callback registered. */
  };

  private _beginSynchronizedOutput(): void {
    if (this._synchronized) {
      return;
    }

    const timer = setTimeout(() => {
      this._endSynchronizedOutput();
    }, XtermScreen.SYNCHRONIZED_OUTPUT_TIMEOUT_MS);
    timer.unref();
    this._synchronized = {
      snapshot: this._snapshot(false, this._getTheme()),
      textRows: this._readTextRows(),
      timer,
    };
  }

  private _endSynchronizedOutput(): void {
    if (!this._synchronized) {
      return;
    }

    clearTimeout(this._synchronized.timer);
    this._synchronized = null;
    this._refresh();
  }

  private _readTextRows(): (TerminalTextPosition | null)[] {
    const buffer = this._terminal.buffer.active;
    const start = buffer.baseY - this._offset;
    const rows: (TerminalTextPosition | null)[] = [];
    for (let y = 0; y < this.rows; y++) {
      // All wrapped rows share one logical line, including its scrollback prefix.
      const previous = rows[y - 1];
      rows.push(
        previous && buffer.getLine(start + y)?.isWrapped
          ? previous
          : this._readTextAt(0, y),
      );
    }

    return rows;
  }

  private _readTextAt(x: number, y: number): TerminalTextPosition | null {
    if (outsideViewport(x, y, this.cols, this.rows)) {
      return null;
    }

    const buffer = this._terminal.buffer.active;
    const clicked = buffer.baseY - this._offset + y;
    let start = clicked;
    while (start > 0 && buffer.getLine(start)?.isWrapped) {
      start--;
    }

    const position: TerminalTextPosition = { text: '', index: 0, cells: [] };
    const viewportStart = buffer.baseY - this._offset;
    for (let row = start; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line || (row > start && !line.isWrapped)) {
        break;
      }

      appendTextLine(
        position,
        buffer,
        row,
        clicked,
        x,
        viewportStart,
        this.cols,
        this.rows,
      );
    }

    return position;
  }

  private _snapshot(live: boolean, theme: Theme): TerminalSnapshot {
    const buffer = this._terminal.buffer.active;
    const cell = buffer.getNullCell();
    const lines: TerminalCell[][] = [];
    const wrapped: boolean[] = [];
    const start = buffer.baseY - (live ? 0 : this._offset);
    for (let y = 0; y < this.rows; y++) {
      const line: TerminalCell[] = [];
      const source = buffer.getLine(start + y);

      wrapped.push(source?.isWrapped ?? false);

      for (let x = 0; x < this.cols; x++) {
        line.push(snapshotCell(source?.getCell(x, cell), theme));
      }

      lines.push(line);
    }

    return {
      lines,
      wrapped,
      cursor: {
        x: buffer.cursorX,
        y: buffer.cursorY,
        visible: this._cursorVisible && (live || this._offset === 0),
      },
      scrollOffset: live ? 0 : this._offset,
    };
  }
  private _reportColor(command: number, color: number, index?: number): void {
    const rgb = [16, 8, 0]
      .map((shift) =>
        ((color >> shift) & 255).toString(16).padStart(2, '0').repeat(2),
      )
      .join('/');

    const paletteIndex = index === undefined ? '' : String(index) + ';';

    this._response(`\x1b]${command};${paletteIndex}rgb:${rgb}\x1b\\`);
  }
}

function cellText(cell: IBufferCell): string {
  return cell.isInvisible()
    ? ' '.repeat(cell.getWidth())
    : cell.getChars() || ' ';
}

function foregroundColor(cell: IBufferCell, theme: Theme): number {
  if (cell.isFgRGB()) {
    return cell.getFgColor();
  }

  if (cell.isFgPalette()) {
    return paletteColor(cell.getFgColor(), theme);
  }

  return theme.colors.fg;
}

function backgroundColor(cell: IBufferCell, theme: Theme): number {
  if (cell.isBgRGB()) {
    return cell.getBgColor();
  }

  if (cell.isBgPalette()) {
    return paletteColor(cell.getBgColor(), theme);
  }

  return theme.colors.bg;
}

function snapshotCell(
  cell: IBufferCell | undefined,
  theme: Theme,
): TerminalCell {
  if (!cell) {
    return {
      text: ' ',
      width: 1,
      style: { fg: theme.colors.fg, bg: theme.colors.bg },
    };
  }

  const style: CellStyle = {
    fg: foregroundColor(cell, theme),
    bg: backgroundColor(cell, theme),
    bold: Boolean(cell.isBold()),
    dim: Boolean(cell.isDim()),
    italic: Boolean(cell.isItalic()),
    underline: Boolean(cell.isUnderline()),
    inverse: Boolean(cell.isInverse()),
    strikethrough: Boolean(cell.isStrikethrough()),
  };

  return { text: cellText(cell), width: cell.getWidth(), style };
}

function wrapPadding(
  buffer: IBuffer,
  row: number,
  col: number,
  cell: IBufferCell,
  cols: number,
): boolean {
  if (col !== cols - 1 || cell.getChars()) {
    return false;
  }

  const next = buffer.getLine(row + 1);

  return Boolean(next?.isWrapped && next.getCell(0)?.getWidth() === 2);
}

function appendTextLine(
  position: TerminalTextPosition,
  buffer: IBuffer,
  row: number,
  clicked: number,
  x: number,
  viewportStart: number,
  cols: number,
  rows: number,
): void {
  const line = buffer.getLine(row);
  if (!line) {
    return;
  }

  const reusable = buffer.getNullCell();
  for (let col = 0; col < cols; col++) {
    const cell = line.getCell(col, reusable);
    if (!cell?.getWidth() || wrapPadding(buffer, row, col, cell, cols)) {
      continue;
    }

    if (row === clicked && col <= x && col + cell.getWidth() > x) {
      position.index = position.text.length;
    }

    const value = cellText(cell);
    const viewportY = row - viewportStart;
    if (viewportY >= 0 && viewportY < rows) {
      position.cells.push({
        x: col,
        y: viewportY,
        width: cell.getWidth(),
        index: position.text.length,
        length: value.length,
      });
    }

    position.text += value;
  }
}

function outsideViewport(
  x: number,
  y: number,
  cols: number,
  rows: number,
): boolean {
  return x < 0 || x >= cols || y < 0 || y >= rows;
}
