import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/Controller.js';
import { defaultConfig } from '../src/model.js';
import { SessionManager } from '../src/terminal/SessionManager.js';
import { attachInput } from '../src/ui/input.js';
import { FakePty } from './FakePty.js';
import { FakeScreen } from './FakeScreen.js';
import type { InputHost } from '../src/ui/input.js';

void test('input bridge routes Unicode and paste once, and intercepts prefix commands', async () => {
  const config = defaultConfig();
  config.places.push({
    id: 'p',
    name: 'Project',
    directory: '/tmp',
    agents: [{ id: 'a', name: 'A', profileId: 'codex' }],
    activeAgentId: 'a',
  });
  config.activePlaceId = 'p';

  const child = new FakePty();
  const manager = new SessionManager(
    () => child,
    (c, r) => new FakeScreen(c, r),
    () => {
      /* Test stub. */
    },
    () => {
      /* Test stub. */
    },
    0,
    async () => {
      /* Test stub. */
    },
  );
  const controller = new Controller(
    config,
    manager,
    {
      save: async () => {
        /* Test stub. */
      },
      flush: async () => {
        /* Test stub. */
      },
    },
    () => {
      /* Test stub. */
    },
    async () => {
      /* Test stub. */
    },
  );
  controller.restoreTerminals();

  let send: (event: unknown) => void = () => {
    /* Test stub. */
  };

  const host: InputHost = {
    keys: () => {
      /* Test stub. */
    },
    onEvent: (handler) => {
      send = handler;

      return () => {
        send = () => {
          /* Detached input is ignored. */
        };
      };
    },
  };
  const detach = attachInput(host, controller);

  const text = (codepoint: number) => {
    send({ kind: 'engine', event: { kind: 'text', codepoint } });
  };

  assert.equal(controller.session?.status, 'running');

  send({ kind: 'engine', event: { kind: 'text', codepoint: 0x1f986 } });
  send({
    kind: 'engine',
    event: { kind: 'paste', bytes: new TextEncoder().encode('a\nb') },
  });
  text(3);
  text(-1);

  assert.deepEqual(child.writes, ['🦆', 'a\rb', '\x03']);

  const key = (key: number, mods: number, timeMs: number) => {
    send({
      kind: 'engine',
      event: { kind: 'key', key, mods, action: 'down', timeMs },
    });
  };

  key(1, 0, 100);
  key(4, 0, 100); // Legacy Alt+Backspace: ESC + DEL.
  await Promise.resolve();

  assert.equal(
    child.writes.at(-1),
    '\x1b\x7f',
    'Alt+Backspace must be a single PTY write',
  );

  key(1, 0, 200);
  send({ kind: 'engine', event: { kind: 'text', codepoint: 8, timeMs: 200 } });

  assert.equal(
    child.writes.at(-1),
    '\x1b\x08',
    'legacy ESC + BS remains one chord',
  );

  key(1, 0, 300);
  send({ kind: 'engine', event: { kind: 'text', codepoint: 98, timeMs: 300 } });

  assert.equal(child.writes.at(-1), '\x1bb');

  key(4, 4, 400); // Enhanced keyboard protocol already carries Alt.
  await Promise.resolve();

  assert.equal(child.writes.at(-1), '\x1b\x7f');

  key(1, 0, 500);
  await Promise.resolve();
  key(4, 0, 600);
  await Promise.resolve();

  assert.deepEqual(
    child.writes.slice(-2),
    ['\x1b', '\x7f'],
    'a separate Escape must stay independent',
  );

  const writesBeforeDialog = child.writes.length;

  text(2);
  text(122); // Close confirmation
  send({ kind: 'paste', bytes: new TextEncoder().encode('hidden') });

  assert.equal(child.writes.length, writesBeforeDialog);

  send({
    kind: 'engine',
    event: { kind: 'key', key: 1, mods: 0, action: 'down' },
  });
  await Promise.resolve();

  assert.equal(Boolean(controller.modal), false);

  text(2);
  text(63); // Legacy Ctrl+B, then ?.

  assert.equal(controller.modal?.kind, 'help');

  key(1, 0, 700);
  await Promise.resolve();

  assert.equal(Boolean(controller.modal), false);

  key(98, 2, 800); // Enhanced Ctrl+B.
  key(63, 1, 900); // Enhanced ? plus its matching text event.
  send({ kind: 'engine', event: { kind: 'text', codepoint: 63, timeMs: 900 } });
  await Promise.resolve();

  assert.equal(controller.modal.kind, 'help');
  assert.equal(
    child.writes.length,
    writesBeforeDialog,
    'neither help keystroke is forwarded',
  );

  key(1, 0, 1000);
  detach();
  await Promise.resolve();

  assert.equal(
    controller.modal.kind,
    'help',
    'pending Escape is discarded on detach',
  );

  await manager.shutdown();
});
