import { defined } from './defined.js';
import { graphemes, textWidth } from './ui/text.js';

type PromptRow = {
  text: string;
  start: number;
  end: number;
};

export class PromptEditor {
  public text = '';
  public cursor = 0;
  public offset = 0;
  private _column: number | null = null;
  private _rowStart: number | null = null;

  public insert(value: string): void {
    const text = value
      .replace(/\r\n?/gu, '\n')
      .replace(/\t/gu, '    ')
      // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '');

    this.text =
      this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor);
    this.cursor += text.length;
    this._column = null;
    this._rowStart = null;
  }

  public layout(width: number): {
    rows: PromptRow[];
    row: number;
    column: number;
  } {
    const rows: PromptRow[] = [];
    let start = 0;
    for (const line of this.text.split('\n')) {
      let text = '',
        used = 0,
        end = start;
      for (const glyph of graphemes(line)) {
        const cells = textWidth(glyph);
        // Reserve a cell for the cursor at the end of a full line.
        if (text && used + cells > Math.max(1, width - 1)) {
          rows.push({ text, start, end });
          start = end;
          text = '';
          used = 0;
        }

        text += glyph;
        used += cells;
        end += glyph.length;
      }

      rows.push({ text, start, end });
      start = end + 1;
    }

    let row = 0;
    for (let i = 0; i < rows.length; i++) {
      if (defined(rows[i]).start <= this.cursor) {
        row = i;
      }
    }

    const previous = rows.findIndex(
      (line) => line.start === this._rowStart && line.end === this.cursor,
    );
    if (previous >= 0) {
      row = previous;
    }

    return {
      rows,
      row,
      column: textWidth(this.text.slice(defined(rows[row]).start, this.cursor)),
    };
  }

  public key(key: string, width: number, ctrl = false): void {
    if (key === 'up' || key === 'down') {
      this._verticalKey(key, width);

      return;
    }

    this._column = null;
    this._rowStart = null;

    const before =
      graphemes(this.text.slice(0, this.cursor)).at(-1)?.length ?? 0;
    const after = graphemes(this.text.slice(this.cursor))[0]?.length ?? 0;
    const actions: Record<string, () => void> = {
      left: () => {
        this.cursor -= before;
      },
      right: () => {
        this.cursor += after;
      },
      home: () => {
        this.cursor =
          ctrl || this.cursor === 0
            ? 0
            : this.text.lastIndexOf('\n', this.cursor - 1) + 1;
      },
      end: () => {
        const end = this.text.indexOf('\n', this.cursor);
        this.cursor = ctrl || end < 0 ? this.text.length : end;
      },
      backspace: () => {
        this.text =
          this.text.slice(0, this.cursor - before) +
          this.text.slice(this.cursor);
        this.cursor -= before;
      },
      delete: () => {
        this.text =
          this.text.slice(0, this.cursor) +
          this.text.slice(this.cursor + after);
      },
      enter: () => {
        this.insert('\n');
      },
      tab: () => {
        this.insert('    ');
      },
    };
    actions[key]?.();
  }

  private _verticalKey(key: string, width: number): void {
    const layout = this.layout(width);
    this._column ??= layout.column;

    const row = defined(
      layout.rows[
        Math.max(
          0,
          Math.min(
            layout.row + (key === 'up' ? -1 : 1),
            layout.rows.length - 1,
          ),
        )
      ],
    );

    this._rowStart = row.start;

    let column = 0;
    this.cursor = row.start;

    for (const glyph of graphemes(row.text)) {
      column += textWidth(glyph);
      if (column > this._column) {
        break;
      }

      this.cursor += glyph.length;
    }
  }
}
