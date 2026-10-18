import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Frame } from '../src/ui/Frame.js';
import { textWidth } from '../src/ui/text.js';
import type { CellStyle } from '../src/terminal/contracts.js';

void test('Unicode labels clip by cells and preserve combining graphemes', () => {
  assert.equal(textWidth('A世界🦆e\u0301'), 8);

  const frame = new Frame(6, 1);
  frame.text(0, 0, 'A世界Z', Frame.BASE_STYLE, 4);

  assert.equal(frame.plainText(), 'A世   ');
  assert.equal(frame.cells[0]?.[2]?.width, 0);
});
void test('terminal paints exact cells and only the focused terminal cursor', () => {
  const frame = new Frame(6, 3);
  const snapshot = {
    lines: [[{ text: 'X', width: 1, style: { fg: 0xff0000, bg: 0 } }]],
    cursor: { x: 0, y: 0, visible: true },
    scrollOffset: 0,
  };

  frame.terminal({ x: 2, y: 1, w: 2, h: 1 }, snapshot, true);

  assert.equal(frame.cells[1]?.[2]?.text, 'X');
  assert.equal(frame.cells[1][2].style.inverse, true);
  assert.equal(frame.cells[1][2].style.fg, 0xff0000);

  frame.terminal({ x: 2, y: 1, w: 2, h: 1 }, snapshot, false);

  assert.equal(frame.cells[1][2].style.inverse, undefined);
});
void test('dialog overlays do not leave half of a wide terminal glyph', () => {
  const frame = new Frame(8, 1);
  frame.text(0, 0, '世ab界Z');
  frame.fill({ x: 1, y: 0, w: 4, h: 1 }, Frame.BASE_STYLE);

  assert.equal(
    frame.runs(0).reduce((sum, run) => sum + textWidth(run.text), 0),
    8,
  );
  assert.equal(frame.cells[0]?.[0]?.text, ' ');
  assert.equal(frame.cells[0][5]?.width, 1);
});

void test('text runs merge equivalent styles and preserve each visible attribute', () => {
  const frame = new Frame(3, 1);
  frame.text(0, 0, 'a', { fg: 1, bg: 2 });
  frame.text(1, 0, 'b', { bg: 2, fg: 1, bold: false });

  const attributes: CellStyle[] = [
    { fg: 3, bg: 2 },
    { fg: 1, bg: 3 },
    ...(
      [
        'bold',
        'dim',
        'italic',
        'underline',
        'inverse',
        'strikethrough',
      ] as const
    ).map((attribute) => ({ fg: 1, bg: 2, [attribute]: true })),
  ];
  for (const style of attributes) {
    frame.text(2, 0, 'c', style);

    assert.deepEqual(frame.runs(0), [
      { text: 'ab', style: { fg: 1, bg: 2 } },
      { text: 'c', style },
    ]);
  }
});
