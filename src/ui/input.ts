import { decodeReziEvent, encodeKey, NO_MODS } from '../terminal/input.js';
import type { Controller } from '../Controller.js';
import type { InputEvent, Modifiers } from '../terminal/input.js';

export type InputHost = {
  keys(bindings: Record<string, () => void>): void;
  onEvent(handler: (event: unknown) => void): () => void;
};

/** The cell surface has no generic widget focus. Terminal keys and input are
 * routed through the same controller, without a second stdin reader. */
export function attachInput(
  app: InputHost,
  controller: Controller,
): () => void {
  const special = [
    'enter',
    'tab',
    'backspace',
    'escape',
    'space',
    'up',
    'down',
    'left',
    'right',
    'home',
    'end',
    'insert',
    'delete',
    'pageup',
    'pagedown',
    ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  ];

  const bindings: Record<string, () => void> = {};

  const bind = (key: string, mods: Modifiers) => {
    const prefix = [
      mods.ctrl ? 'ctrl' : '',
      mods.alt ? 'alt' : '',
      mods.shift ? 'shift' : '',
    ].filter(Boolean);
    // Consume Rezi shortcuts; engine events below are the single input source.
    bindings[[...prefix, key].join('+')] = () => {
      /* No callback registered. */
    };
  };

  for (const key of special) {
    for (let mask = 0; mask < 8; mask++) {
      bind(key, {
        ctrl: Boolean(mask & 1),
        alt: Boolean(mask & 2),
        shift: Boolean(mask & 4),
        meta: false,
      });
    }
  }

  for (const key of 'abcdefghijklmnopqrstuvwxyz[]\\^_@?') {
    bind(key, { ...NO_MODS, ctrl: true });
    bind(key, { ...NO_MODS, alt: true });
    bind(key, { ...NO_MODS, ctrl: true, alt: true });
  }

  // Rezi treats an unhandled q/Q as an application quit shortcut.
  bind('q', NO_MODS);
  bind('q', { ...NO_MODS, shift: true });
  app.keys(bindings);

  let pending: PendingInput | null = null;
  let disposed = false;

  const flush = () => {
    if (!pending) {
      return;
    }

    const input = pending.input;
    pending = null;
    controller.handle(input);
  };

  const detach = app.onEvent((event) => {
    let input = decodeReziEvent(event);
    if (!input) {
      return;
    }

    const outer = event as {
      kind?: string;
      event?: { timeMs?: unknown };
      timeMs?: unknown;
    };
    const time = outer.kind === 'engine' ? outer.event?.timeMs : outer.timeMs;
    // Legacy Alt is ESC followed by a key/text event in the same native batch.
    // Forward it as one PTY write, so raw-mode applications never interpret
    // the ESC prefix as a standalone key before the rest of the chord arrives.
    if (nativeAltPair(pending, input, time)) {
      pending = null;
      if (input.kind === 'key') {
        input = { ...input, mods: { ...input.mods, alt: true } };
      } else if (input.kind === 'text') {
        input = { kind: 'text', text: '\x1b' + input.text };
      }
    }

    // Enhanced keyboard protocols can emit a key followed by text for the same
    // keystroke. Wait until the next event/microtask and forward that pair once.
    if (duplicateText(pending, input, time)) {
      flush();

      return;
    }

    flush();
    if (input.kind === 'key') {
      const text = encodeKey(input.key, input.mods, {
        alternateScreen: false,
        alternateScroll: true,
        applicationCursorKeys: false,
        bracketedPasteMode: false,
        sendFocus: false,
        mouseTrackingMode: 'none',
        mouseEncoding: 'default',
      });
      const routed: InputEvent = printableKey(input)
        ? { kind: 'text', text }
        : input;

      pending = { input: routed, text, time };

      const queued = pending;
      queueMicrotask(() => {
        if (!disposed && pending === queued) {
          flush();
        }
      });

      return;
    }

    input = controlText(input);
    controller.handle(input);
  });

  return () => {
    disposed = true;
    pending = null;
    detach();
  };
}

type PendingInput = { input: InputEvent; text: string; time: unknown };

function plainEscape(input: InputEvent): boolean {
  if (input.kind !== 'key' || input.key !== 'escape') {
    return false;
  }

  const { ctrl, alt, shift, meta } = input.mods;

  return !ctrl && !alt && !shift && !meta;
}

function nativeAltPair(
  pending: PendingInput | null,
  input: InputEvent,
  time: unknown,
): boolean {
  return Boolean(
    pending &&
    plainEscape(pending.input) &&
    time !== undefined &&
    time === pending.time &&
    (input.kind === 'key' || input.kind === 'text'),
  );
}

function printableKey(input: Extract<InputEvent, { kind: 'key' }>): boolean {
  const { ctrl, alt, meta } = input.mods;

  return (
    (input.key.length === 1 || input.key === 'space') && !ctrl && !alt && !meta
  );
}

function controlText(input: InputEvent): InputEvent {
  if (input.kind !== 'text' || input.text.length !== 1) {
    return input;
  }

  const cp = input.text.charCodeAt(0);
  const key = controlKey(cp);
  if (key) {
    return { kind: 'key', key, mods: { ...NO_MODS, ctrl: true } };
  }

  const special: Record<number, string> = {
    9: 'tab',
    13: 'enter',
    27: 'escape',
    127: 'backspace',
  };
  const specialKey = special[cp];

  return specialKey ? { kind: 'key', key: specialKey, mods: NO_MODS } : input;
}

function duplicateText(
  pending: PendingInput | null,
  input: InputEvent,
  time: unknown,
): boolean {
  return Boolean(
    pending &&
    input.kind === 'text' &&
    time !== undefined &&
    time === pending.time &&
    input.text === pending.text,
  );
}

function controlKey(cp: number): string | undefined {
  if (cp >= 1 && cp <= 26 && cp !== 9 && cp !== 13) {
    return String.fromCharCode(cp + 96);
  }

  if ((cp >= 28 && cp <= 31) || cp === 0) {
    return cp ? String.fromCharCode(cp + 64) : '@';
  }

  return undefined;
}
