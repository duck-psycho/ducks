import { rgb, ui } from '@rezi-ui/core';
import { renderFrame } from './view.js';
import type { Controller } from '../Controller.js';
import type { VNode } from '@rezi-ui/core';
export { attachInput } from './input.js';
export { WORKING_FRAME_MS } from './view.js';

function color(value: number) {
  return rgb((value >> 16) & 255, (value >> 8) & 255, value & 255);
}

export function view(controller: Controller, repaint = false): VNode {
  const frame = renderFrame(controller);

  return ui.column(
    { width: frame.cols, height: frame.rows, gap: 0, p: 0, overflow: 'hidden' },
    frame.cells.map((_, y) =>
      ui.row(
        {
          key: `row-${y}`,
          width: frame.cols,
          height: 1,
          gap: 0,
          p: 0,
          overflow: 'hidden',
        },
        [
          ui.richText(
            frame.runs(y).map((run) => ({
              text: run.text,
              style: {
                // Equivalent SGR encodings invalidate the native cell diff without
                // flashing a blank frame or changing the visible colors. Rezi does
                // not expose screen invalidation for a missed shrink/grow resize.
                fg: color(
                  Boolean(run.style.inverse) !== repaint
                    ? run.style.bg
                    : run.style.fg,
                ),
                bg: color(
                  Boolean(run.style.inverse) !== repaint
                    ? run.style.fg
                    : run.style.bg,
                ),
                inverse: repaint,
                bold: run.style.bold ?? false,
                dim: run.style.dim ?? false,
                italic: run.style.italic ?? false,
                underline: run.style.underline ?? false,
                strikethrough: run.style.strikethrough ?? false,
              },
            })),
          ),
        ],
      ),
    ),
  );
}
