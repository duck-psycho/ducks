import type { TerminalModes } from './contracts.js';

export type Modifiers = {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
};

export const NO_MODS: Modifiers = {
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};
export type InputEvent =
  | { kind: 'key'; key: string; mods: Modifiers }
  | { kind: 'modifiers'; mods: Modifiers }
  | { kind: 'text'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'resize'; cols: number; rows: number }
  // Match Rezi: negative wheelY scrolls up, positive scrolls down.
  | {
      kind: 'mouse';
      x: number;
      y: number;
      action: number;
      buttons: number;
      wheelY: number;
      mods: Modifiers;
    };

function encodeCharacter(key: string, mods: Modifiers): string {
  let value = mods.shift ? key.toUpperCase() : key;
  if (mods.ctrl) {
    if (key === ' ' || key === '@') {
      value = '\0';
    } else if (key === '?') {
      value = '\x7f';
    } else {
      const code = key.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) {
        value = String.fromCharCode(code & 31);
      }
    }
  }

  return (mods.alt || mods.meta ? '\x1b' : '') + value;
}

function encodeSpecial(
  key: string,
  mods: Modifiers,
  modifier: number,
): string | undefined {
  const alt = mods.alt || mods.meta;
  if (shiftTab(key, mods)) {
    return '\x1b[Z';
  }

  const enhanced: Record<string, number> = { enter: 13, tab: 9 };
  const code = enhanced[key];
  if (code && modifier > 1) {
    return '\x1b[' + String(code) + ';' + String(modifier) + 'u';
  }

  if (key === 'backspace' && mods.ctrl) {
    return (alt ? '\x1b' : '') + '\x08';
  }

  const simple: Record<string, string> = {
    enter: '\r',
    tab: '\t',
    backspace: '\x7f',
    escape: '\x1b',
    space: ' ',
  };
  const value = simple[key];
  if (value !== undefined) {
    return (alt ? '\x1b' : '') + value;
  }

  return undefined;
}

function encodeSequence(
  key: string,
  modifier: number,
  modes: TerminalModes,
): string | undefined {
  const arrows: Record<string, string> = {
    up: 'A',
    down: 'B',
    right: 'C',
    left: 'D',
    home: 'H',
    end: 'F',
  };
  const final = arrows[key];
  if (final) {
    if (modifier > 1) {
      return `\x1b[1;${modifier}${final}`;
    }

    return `\x1b${modes.applicationCursorKeys ? 'O' : '['}${final}`;
  }

  const tilde: Record<string, number> = {
    insert: 2,
    delete: 3,
    pageup: 5,
    pagedown: 6,
    f5: 15,
    f6: 17,
    f7: 18,
    f8: 19,
    f9: 20,
    f10: 21,
    f11: 23,
    f12: 24,
  };

  const suffix = modifier > 1 ? ';' + String(modifier) : '';
  if (tilde[key]) {
    return `\x1b[${tilde[key]}${suffix}~`;
  }

  const functionKey: Record<string, string> = {
    f1: 'P',
    f2: 'Q',
    f3: 'R',
    f4: 'S',
  };
  const functionFinal = functionKey[key];
  if (functionFinal) {
    return modifier > 1
      ? `\x1b[1;${modifier}${functionFinal}`
      : `\x1bO${functionFinal}`;
  }

  return undefined;
}

export function encodeKey(
  key: string,
  mods: Modifiers,
  modes: TerminalModes,
): string {
  const alt = mods.alt || mods.meta;
  const modifier =
    1 + Number(mods.shift) + 2 * Number(alt) + 4 * Number(mods.ctrl);
  const sequence =
    encodeSequence(key, modifier, modes) ?? encodeSpecial(key, mods, modifier);
  if (sequence !== undefined) {
    return sequence;
  }

  if (key === 'focusin' || key === 'focusout') {
    if (!modes.sendFocus) {
      return '';
    }

    return `\x1b[${key === 'focusin' ? 'I' : 'O'}`;
  }

  return key.length === 1 ? encodeCharacter(key, mods) : '';
}

export function encodePaste(text: string, modes: TerminalModes): string {
  // Prevent embedded end markers from escaping the child's paste frame.
  const payload = text.replaceAll('\x1b[201~', '');

  return modes.bracketedPasteMode
    ? `\x1b[200~${payload}\x1b[201~`
    : payload.replace(/\r?\n/gu, '\r');
}

type MouseEvent = Extract<InputEvent, { kind: 'mouse' }>;

function tracksMouse(event: MouseEvent, modes: TerminalModes): boolean {
  if (modes.mouseTrackingMode === 'none') {
    return false;
  }

  if (modes.mouseTrackingMode === 'x10' && event.action !== 3) {
    return false;
  }

  if (event.action === 1 && modes.mouseTrackingMode !== 'any') {
    return false;
  }

  if (
    event.action === 2 &&
    !['any', 'drag'].includes(modes.mouseTrackingMode)
  ) {
    return false;
  }

  return event.action !== 5 || event.wheelY !== 0;
}

function mouseButton(event: MouseEvent): number {
  if (event.action === 5) {
    return event.wheelY < 0 ? 64 : 65;
  }

  if (event.buttons & 1) {
    return 0;
  }

  if (event.buttons & 2) {
    return 1;
  }

  if (event.buttons & 4) {
    return 2;
  }

  return 3;
}

export function encodeMouse(event: MouseEvent, modes: TerminalModes): string {
  if (!tracksMouse(event, modes)) {
    return '';
  }

  let button = mouseButton(event);
  if (event.action === 1 || event.action === 2) {
    button += 32;
  }

  button +=
    Number(event.mods.shift) * 4 +
    Number(event.mods.alt || event.mods.meta) * 8 +
    Number(event.mods.ctrl) * 16;

  const x = event.x + 1,
    y = event.y + 1;
  if (modes.mouseEncoding === 'sgr') {
    return `\x1b[<${button};${x};${y}${event.action === 4 ? 'm' : 'M'}`;
  }

  if (x > 223 || y > 223) {
    return '';
  }

  if (event.action === 4) {
    button = 3 + (button & 28);
  }

  return '\x1b[M' + String.fromCharCode(32 + button, 32 + x, 32 + y);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function decodeModifiers(value: unknown): Modifiers {
  const mods = number(value);

  return {
    shift: Boolean(mods & 1),
    ctrl: Boolean(mods & 2),
    alt: Boolean(mods & 4),
    meta: Boolean(mods & 8),
  };
}

export function decodeReziEvent(value: unknown): InputEvent | null {
  const outer = record(value);
  const e = outer?.['kind'] === 'engine' ? record(outer['event']) : outer;
  if (!e) {
    return null;
  }

  if (e['kind'] === 'key') {
    return decodeKeyEvent(e);
  }

  if (e['kind'] === 'text') {
    return decodeTextEvent(e);
  }

  if (e['kind'] === 'paste' && e['bytes'] instanceof Uint8Array) {
    return { kind: 'paste', text: new TextDecoder().decode(e['bytes']) };
  }

  if (e['kind'] === 'resize') {
    return { kind: 'resize', cols: number(e['cols']), rows: number(e['rows']) };
  }

  if (e['kind'] === 'mouse') {
    return {
      kind: 'mouse',
      x: number(e['x']),
      y: number(e['y']),
      action: number(e['mouseKind']),
      buttons: number(e['buttons']),
      wheelY: number(e['wheelY']),
      mods: decodeModifiers(e['mods']),
    };
  }

  return null;
}

function decodeKeyEvent(e: Record<string, unknown>): InputEvent | null {
  // Enhanced protocols report releases, including Ctrl itself. Preserve
  // their modifier state without forwarding a key release to the child.
  if (e['action'] === 'up') {
    return { kind: 'modifiers', mods: decodeModifiers(e['mods']) };
  }

  const names: Record<number, string> = {
    1: 'escape',
    2: 'enter',
    3: 'tab',
    4: 'backspace',
    10: 'insert',
    11: 'delete',
    12: 'home',
    13: 'end',
    14: 'pageup',
    15: 'pagedown',
    20: 'up',
    21: 'down',
    22: 'left',
    23: 'right',
    32: 'space',
  };

  const code = number(e['key']);
  let key = names[code];
  if (!key && code >= 100 && code <= 111) {
    key = 'f' + String(code - 99);
  } else if (!key && code >= 33 && code <= 126) {
    key = String.fromCharCode(code).toLowerCase();
  }

  return key ? { kind: 'key', key, mods: decodeModifiers(e['mods']) } : null;
}

function decodeTextEvent(e: Record<string, unknown>): InputEvent | null {
  let text = '';
  if (typeof e['text'] === 'string') {
    text = e['text'];
  } else if (
    typeof e['codepoint'] === 'number' &&
    e['codepoint'] >= 0 &&
    e['codepoint'] <= 0x10ffff
  ) {
    text = String.fromCodePoint(e['codepoint']);
  }

  return text ? { kind: 'text', text } : null;
}

function shiftTab(key: string, mods: Modifiers): boolean {
  return key === 'tab' && mods.shift && !mods.ctrl && !mods.alt && !mods.meta;
}
