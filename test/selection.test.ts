import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalSelection } from '../src/terminal/TerminalSelection.js';
import { XtermScreen } from '../src/terminal/XtermScreen.js';

void test('selection preserves Unicode, joins soft wraps and separates hard lines in either direction', async () => {
  const screen = new XtermScreen(8, 5);

  try {
    await new Promise<void>((resolve) => {
      screen.write('abcdefg界e\u0301Z\r\nnext', resolve);
    });

    const selection = new TerminalSelection(screen.snapshot(), 8, 5, 0, 0);

    selection.move(3, 2);

    assert.equal(selection.text, 'abcdefg界e\u0301Z\nnext');

    const reverse = new TerminalSelection(screen.snapshot(), 8, 5, 3, 2);

    reverse.move(0, 0);

    assert.equal(reverse.text, selection.text);

    const wide = new TerminalSelection(screen.snapshot(), 8, 5, 1, 1);

    wide.move(2, 1);

    assert.equal(wide.text, '界e\u0301');
    assert.equal(wide.contains(0, 1), true);
    assert.equal(wide.contains(1, 1), true);
    assert.equal(wide.contains(3, 1), false);

    await new Promise<void>((resolve) => {
      screen.write('\x1b[2J\x1b[Hreplacement', resolve);
    });

    assert.equal(selection.text, 'abcdefg界e\u0301Z\nnext');
  } finally {
    screen.dispose();
  }
});

void test('selection reads the scrolled viewport and clamps gestures outside its bounds', async () => {
  const screen = new XtermScreen(8, 2);

  try {
    await new Promise<void>((resolve) => {
      screen.write('first\r\nsecond\r\nthird\r\nfourth', resolve);
    });
    screen.scroll(2);

    const selection = new TerminalSelection(screen.snapshot(), 8, 2, 0, 0);

    assert.equal(selection.text, '');

    selection.move(100, 100);

    assert.equal(selection.text, 'first\nsecond');

    selection.move(-100, -100);

    assert.equal(selection.empty, true);
  } finally {
    screen.dispose();
  }
});
