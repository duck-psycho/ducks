import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createApp,
  createTestRenderer,
  DEFAULT_TERMINAL_CAPS,
  rgb,
  TestEventBuilder,
} from '@rezi-ui/core';
import { Controller } from '../src/Controller.js';
import { defined } from '../src/defined.js';
import { defaultConfig } from '../src/model.js';
import { SessionManager } from '../src/terminal/SessionManager.js';
import { XtermScreen } from '../src/terminal/XtermScreen.js';
import { attachInput } from '../src/ui/input.js';
import { layout } from '../src/ui/layout.js';
import { view } from '../src/ui/rezi.js';
import { FakePty } from './FakePty.js';
import { FakeScreen } from './FakeScreen.js';
import type { BackendEventBatch, RuntimeBackend } from '@rezi-ui/core';

void test('runtime renderer updates terminal text and color-only Working animation frames', async () => {
  const config = defaultConfig();
  const agent = { id: 'a', name: 'Shell', profileId: 'shell' };
  const place = {
    id: 'p',
    name: 'Example',
    directory: '/tmp',
    agents: [agent],
    activeAgentId: agent.id,
  };

  config.places.push(place);
  config.activePlaceId = place.id;

  const manager = new SessionManager(
    () => new FakePty(),
    (c, r) => new XtermScreen(c, r),
    () => {
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

  controller.handle({ kind: 'resize', cols: 100, rows: 30 });

  const screen = manager.ensure(agent).screen;
  const renderer = createTestRenderer({
    viewport: { cols: 100, rows: 30 },
    mode: 'runtime',
  });
  const area = layout(100, 30).terminal;

  const paint = async (ansi: string) => {
    await new Promise<void>((resolve) => {
      screen.write(`\x1b[H${ansi}`, resolve);
    });

    return renderer.render(view(controller));
  };

  const runs = (result: ReturnType<typeof renderer.render>) =>
    result.ops.filter(
      (op) => op.kind === 'drawText' && op.y === area.y && op.x >= area.x,
    );

  try {
    const first = await paint('\x1b[38;2;80;90;100mWorking\x1b[0m');

    assert.match(first.toText(), /Example/);
    assert.ok(
      runs(first).some(
        (op) =>
          op.kind === 'drawText' &&
          op.text.includes('Working') &&
          op.style?.fg === rgb(80, 90, 100),
      ),
    );

    const next = await paint('\x1b[38;2;180;190;200mWorking\x1b[0m');

    assert.ok(
      runs(next).some(
        (op) =>
          op.kind === 'drawText' &&
          op.text.includes('Working') &&
          op.style?.fg === rgb(180, 190, 200),
      ),
      'unchanged text must receive the new animation color',
    );

    const styled = await paint('\x1b[1;2;3;4;9;48;2;10;20;30mWorking\x1b[0m');

    assert.ok(
      runs(styled).some(
        (op) =>
          op.kind === 'drawText' &&
          op.text.includes('Working') &&
          op.style?.bg === rgb(10, 20, 30) &&
          op.style.bold &&
          op.style.dim &&
          op.style.italic &&
          op.style.underline &&
          op.style.strikethrough,
      ),
    );

    const last = await paint('\x1b[2K\x1b[32mReady\x1b[0m');

    assert.ok(
      runs(last).some(
        (op) => op.kind === 'drawText' && op.text.includes('Ready'),
      ),
    );
    assert.ok(
      !runs(last).some(
        (op) => op.kind === 'drawText' && op.text.includes('Working'),
      ),
    );
  } finally {
    await manager.shutdown();
  }
});

void test('real Rezi event loop forwards prompt text once and keeps q/Ctrl+C inside the terminal', async () => {
  let receive: ((batch: BackendEventBatch) => void) | undefined;
  let stopped = false;
  const backend: RuntimeBackend = {
    start: async () => {
      /* Test stub. */
    },
    stop: () => {
      stopped = true;

      return Promise.resolve();
    },
    dispose: () => {
      /* Test stub. */
    },
    requestFrame: async () => {
      /* Test stub. */
    },
    postUserEvent: () => {
      /* Test stub. */
    },
    pollEvents: () =>
      new Promise((resolve) => {
        receive = resolve;
      }),
    getCaps: () => Promise.resolve(DEFAULT_TERMINAL_CAPS),
  };

  const config = defaultConfig();
  const place = {
    id: 'p',
    name: 'Example',
    directory: '/tmp',
    agents: [{ id: 'a', name: 'Codex', profileId: 'codex' }],
    activeAgentId: 'a',
  };

  config.places.push(place);
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

  manager.start(defined(place.agents[0]), place, defined(config.profiles[0]));
  controller.focus = 'terminal';

  const app = createApp({ backend, initialState: {} });
  app.view(() => view(controller));

  const detach = attachInput(app, controller);

  try {
    await app.start();

    const events = new TestEventBuilder()
      .resize(100, 30)
      .type('quick Q Привет 🦆')
      .pressKey('enter')
      .paste(new TextEncoder().encode('one\ntwo'))
      .add({ kind: 'text', codepoint: 3 }) // legacy Ctrl+C as text
      .add({ kind: 'text', codepoint: 2 })
      .type('n') // legacy Ctrl+B command
      .pressKey('space', { timeMs: 850 })
      .add({ kind: 'text', codepoint: 32, timeMs: 850 })
      .pressKey('a', { mods: 1, timeMs: 900 })
      .add({ kind: 'text', codepoint: 65, timeMs: 900 });

    await new Promise<void>((resolve) => {
      assert.ok(receive);

      receive(events.buildBatch({ onRelease: resolve }));
    });

    assert.equal(child.writes.join(''), 'quick Q Привет 🦆\rone\rtwo\x03 A');
    assert.equal(stopped, false, 'q/Ctrl+C must not stop the multiplexer');
    assert.equal(controller.prefix, false);
  } finally {
    detach();
    await app.stop();
    app.dispose();
    await manager.shutdown();
  }
});
