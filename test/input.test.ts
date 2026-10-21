import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  encodeKey,
  encodeMouse,
  encodePaste,
  NO_MODS,
} from '../src/terminal/input.js';
import { MODES } from './helpers.js';

void test('special keys respect child terminal modes and modifiers', () => {
  assert.equal(encodeKey('up', NO_MODS, MODES), '\x1b[A');
  assert.equal(
    encodeKey('up', NO_MODS, { ...MODES, applicationCursorKeys: true }),
    '\x1bOA',
  );
  assert.equal(
    encodeKey('left', { ...NO_MODS, ctrl: true }, MODES),
    '\x1b[1;5D',
  );
  assert.equal(encodeKey('tab', { ...NO_MODS, shift: true }, MODES), '\x1b[Z');
  assert.equal(encodeKey('c', { ...NO_MODS, ctrl: true }, MODES), '\x03');
  assert.equal(
    encodeKey('enter', { ...NO_MODS, shift: true }, MODES),
    '\x1b[13;2u',
  );
  assert.equal(encodeKey('enter', NO_MODS, MODES), '\r');
  assert.equal(
    encodeKey('backspace', { ...NO_MODS, alt: true }, MODES),
    '\x1b\x7f',
  );
  assert.equal(
    encodeKey('backspace', { ...NO_MODS, meta: true }, MODES),
    '\x1b\x7f',
  );
  assert.equal(encodeKey('b', { ...NO_MODS, alt: true }, MODES), '\x1bb');
  assert.equal(encodeKey('d', { ...NO_MODS, alt: true }, MODES), '\x1bd');
  assert.equal(encodeKey('focusin', NO_MODS, MODES), '');
  assert.equal(
    encodeKey('focusout', NO_MODS, { ...MODES, sendFocus: true }),
    '\x1b[O',
  );
});
void test('paste preserves Unicode and frames multiline input according to child mode', () => {
  assert.equal(
    encodePaste('Hello\n世界', { ...MODES, bracketedPasteMode: true }),
    '\x1b[200~Hello\n世界\x1b[201~',
  );
  assert.equal(encodePaste('a\r\nb\nc', MODES), 'a\rb\rc');
  assert.equal(
    encodePaste('a\x1b[201~b', { ...MODES, bracketedPasteMode: true }),
    '\x1b[200~ab\x1b[201~',
  );
});
void test('mouse coordinates and tracking are encoded for the child', () => {
  const event = {
    kind: 'mouse' as const,
    x: 9,
    y: 4,
    action: 3,
    buttons: 1,
    wheelY: 0,
    mods: NO_MODS,
  };

  assert.equal(encodeMouse(event, MODES), '');
  assert.equal(
    encodeMouse(event, { ...MODES, mouseTrackingMode: 'vt200' }),
    '\x1b[<0;10;5M',
  );
  assert.equal(
    encodeMouse(
      { ...event, action: 4 },
      { ...MODES, mouseTrackingMode: 'vt200' },
    ),
    '\x1b[<0;10;5m',
  );
  assert.equal(
    encodeMouse(
      { ...event, action: 1 },
      { ...MODES, mouseTrackingMode: 'vt200' },
    ),
    '',
  );
});
void test('wheel direction is preserved in SGR and legacy mouse reports', () => {
  const event = {
    kind: 'mouse' as const,
    x: 9,
    y: 4,
    action: 5,
    buttons: 0,
    wheelY: 1,
    mods: NO_MODS,
  };

  const modes = { ...MODES, mouseTrackingMode: 'vt200' as const };

  assert.equal(
    encodeMouse(event, modes),
    '\x1b[<65;10;5M',
    'positive wheelY means down',
  );
  assert.equal(
    encodeMouse({ ...event, wheelY: -1 }, modes),
    '\x1b[<64;10;5M',
    'negative wheelY means up',
  );
  assert.equal(
    encodeMouse(event, { ...modes, mouseEncoding: 'default' }),
    '\x1b[Ma*%',
  );
  assert.equal(
    encodeMouse(
      { ...event, wheelY: -1 },
      { ...modes, mouseEncoding: 'default' },
    ),
    '\x1b[M`*%',
  );
  assert.equal(
    encodeMouse({ ...event, mods: { ...NO_MODS, ctrl: true } }, modes),
    '\x1b[<81;10;5M',
  );
  assert.equal(
    encodeMouse({ ...event, wheelY: 0 }, modes),
    '',
    'horizontal-only wheel events must not scroll vertically',
  );
});
