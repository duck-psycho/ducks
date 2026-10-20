import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { parseConfig } from '../src/config.js';
import { Controller } from '../src/Controller.js';
import { defined } from '../src/defined.js';
import { GitBranches } from '../src/GitBranches.js';
import { defaultConfig } from '../src/model.js';
import { PromptEditor } from '../src/PromptEditor.js';
import { NO_MODS } from '../src/terminal/input.js';
import { SessionManager } from '../src/terminal/SessionManager.js';
import { THEMES } from '../src/themes.js';
import { SIDEBAR_WIDTH } from '../src/ui/layout.js';
import { renderFrame } from '../src/ui/view.js';
import { FakePty } from './FakePty.js';
import { FakeScreen } from './FakeScreen.js';

function setup(
  copyText?: (text: string) => void,
  sidebarWidth = SIDEBAR_WIDTH,
) {
  const config = defaultConfig();
  config.sidebarWidth = sidebarWidth;
  config.places = [
    {
      id: 'p',
      name: 'First',
      directory: '/tmp',
      agents: [
        { id: 'a', name: 'Codex', profileId: 'codex' },
        { id: 'b', name: 'Claude', profileId: 'claude' },
      ],
      activeAgentId: 'a',
    },
    {
      id: 'q',
      name: 'Second',
      directory: '/var',
      agents: [{ id: 'c', name: 'Other', profileId: 'codex' }],
      activeAgentId: 'c',
    },
  ];
  config.activePlaceId = 'p';

  const children: FakePty[] = [];
  const launches: { executable: string; directory: string }[] = [];
  const manager = new SessionManager(
    (profile, directory) => {
      launches.push({ executable: profile.executable, directory });

      const child = new FakePty();
      children.push(child);

      return child;
    },
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
    undefined,
    () => Promise.resolve([]),
  );

  let saved = 0;
  const controller = new Controller(
    config,
    manager,
    {
      save: () => {
        saved++;

        return Promise.resolve();
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
    undefined,
    copyText,
  );
  controller.restoreTerminals();

  const key = (key: string, ctrl = false, shift = false) => {
    controller.handle({ kind: 'key', key, mods: { ...NO_MODS, ctrl, shift } });
  };

  const command = (text: string) => {
    key('b', true);
    controller.handle({ kind: 'text', text });
  };

  return {
    config,
    manager,
    controller,
    children,
    launches,
    key,
    command,
    get saved() {
      return saved;
    },
  };
}

function sidebarMouse(controller: Controller) {
  return (action: number, x: number, y = 5, buttons = action === 4 ? 0 : 1) => {
    controller.handle({
      kind: 'mouse',
      action,
      x,
      y,
      buttons,
      wheelY: 0,
      mods: NO_MODS,
    });
  };
}

void test('divider drag resizes every terminal, saves once on release and isolates the gesture', async () => {
  const context = setup();
  const { controller, config, manager, children } = context;
  const mouse = sidebarMouse(controller);
  const saved = context.saved;
  const focus = controller.focus;
  (defined(controller.session).screen as FakeScreen).modes.mouseTrackingMode =
    'any';

  try {
    mouse(3, SIDEBAR_WIDTH);
    mouse(2, 50);
    mouse(2, 55);

    assert.equal(config.sidebarWidth, 55);
    assert.equal(context.saved, saved);
    for (const session of manager.sessions.values()) {
      assert.equal((session.screen as FakeScreen).cols, 43);
    }

    assert.equal(renderFrame(controller).cells[5]?.[55]?.text, '│');
    assert.ok(controller.tabHits.every((hit) => hit.rect.x >= 56));

    // Release outside the sidebar, including a final movement.
    mouse(4, 60, controller.rows - 1);

    assert.equal(config.sidebarWidth, 60);
    assert.equal(context.saved, saved + 1);
    assert.equal(controller.focus, focus);
    assert.equal(controller.terminalSelection, null);
    assert.ok(children.every((child) => child.writes.length === 0));

    renderFrame(controller);
    const hit = defined(controller.tabHits[1]);
    mouse(3, hit.rect.x + 1, hit.rect.y);

    assert.equal(controller.agent?.id, 'b', 'tabs use the updated geometry');
  } finally {
    await manager.shutdown();
  }
});

void test('resize pointer follows divider hover and drag and resets for dialogs, resize and exit', async () => {
  const { controller, manager, command, key } = setup();
  const mouse = sidebarMouse(controller);
  const hover = (x: number, y = 5) => {
    mouse(1, x, y, 0);
  };

  try {
    assert.equal(controller.pointerShape, '');
    hover(SIDEBAR_WIDTH);

    assert.equal(controller.pointerShape, 'ew-resize');
    hover(SIDEBAR_WIDTH + 1);

    assert.equal(controller.pointerShape, '');
    hover(SIDEBAR_WIDTH, controller.rows - 1);

    assert.equal(controller.pointerShape, '', 'footer is not a resize handle');
    hover(SIDEBAR_WIDTH);
    command('m');

    assert.equal(controller.pointerShape, '', 'modal covers the divider');
    key('escape');

    assert.equal(controller.pointerShape, 'ew-resize');
    mouse(3, SIDEBAR_WIDTH);
    mouse(2, 500, controller.rows - 1);

    assert.equal(controller.pointerShape, 'ew-resize', 'drag stays captured');
    mouse(4, 500, controller.rows - 1);

    assert.equal(controller.pointerShape, '');
    hover(controller.geometry.sidebar.w);
    controller.handle({ kind: 'resize', cols: 120, rows: 30 });

    assert.equal(controller.pointerShape, '');
    hover(controller.geometry.sidebar.w);
    key('focusout');

    assert.equal(controller.pointerShape, '');
    hover(controller.geometry.sidebar.w);
    await controller.quit();

    assert.equal(controller.pointerShape, '');
  } finally {
    await manager.shutdown();
  }
});

void test('sidebar width is restored, constrained during dragging and preserved across window resizes', async () => {
  const context = setup(undefined, 60);
  const { controller, config, manager } = context;
  const mouse = sidebarMouse(controller);

  try {
    assert.equal(controller.geometry.sidebar.w, 60);
    assert.equal((defined(controller.session).screen as FakeScreen).cols, 38);
    controller.handle({ kind: 'resize', cols: 80, rows: 24 });

    assert.equal(controller.geometry.sidebar.w, 58);
    assert.equal(config.sidebarWidth, 60);

    const saved = context.saved;
    mouse(3, 58);
    mouse(4, 58);

    assert.equal(context.saved, saved, 'a click does not overwrite preference');
    controller.handle({ kind: 'resize', cols: 120, rows: 30 });

    assert.equal(controller.geometry.sidebar.w, 60);
    mouse(3, 60);
    mouse(2, -10);

    assert.equal(controller.geometry.sidebar.w, 20);
    mouse(2, 200);
    mouse(4, 200);

    assert.equal(config.sidebarWidth, 98);
    assert.equal(controller.geometry.terminal.w, 20);
    assert.equal(context.saved, saved + 1);
  } finally {
    await manager.shutdown();
  }
});

void test('sidebar dragging ignores other buttons and modals and ends on a window resize', async () => {
  const context = setup();
  const { controller, config, manager, command, key } = context;
  const mouse = sidebarMouse(controller);

  try {
    mouse(3, SIDEBAR_WIDTH, 5, 2);
    mouse(2, 50, 5, 2);
    mouse(4, 50);

    assert.equal(config.sidebarWidth, SIDEBAR_WIDTH);
    command('m');
    mouse(3, SIDEBAR_WIDTH, 0);
    mouse(2, 50, 0);
    mouse(4, 50, 0);

    assert.equal(config.sidebarWidth, SIDEBAR_WIDTH);
    key('escape');
    const saved = context.saved;
    mouse(3, SIDEBAR_WIDTH);
    mouse(2, 50);
    controller.handle({ kind: 'resize', cols: 60, rows: 20 });

    assert.equal(context.saved, saved + 1);
    mouse(4, 10);
    controller.handle({ kind: 'resize', cols: 120, rows: 30 });
    mouse(2, 70);

    assert.equal(config.sidebarWidth, 50, 'interrupted drag does not resume');
  } finally {
    await manager.shutdown();
  }
});

void test('Ctrl hover highlights only resolvable text files, restores styling and rejects stale async checks', async () => {
  const { controller, manager, children } = setup();
  const directory = await mkdtemp(join(tmpdir(), 'ducks-hover-'));
  const file = join(directory, 'text file.txt');
  const originalEditor = process.env['EDITOR'];
  const source = defined(controller.session).screen as FakeScreen;

  const move = (ctrl = true, x = SIDEBAR_WIDTH + 9, y = 1) => {
    controller.handle({
      kind: 'mouse',
      x,
      y,
      action: 1,
      buttons: 0,
      wheelY: 0,
      mods: { ...NO_MODS, ctrl },
    });
  };

  const highlighted = async () => {
    const deadline = Date.now() + 1000;
    while (!controller.hoveredFileCells.length) {
      if (Date.now() >= deadline) {
        throw new Error('hover did not become clickable');
      }

      await delay(1);
    }
  };

  try {
    await writeFile(file, 'hello\n');
    process.env['EDITOR'] = 'vim';
    source.content = `See \`${file}:12\` here`;
    source.modes.mouseTrackingMode = 'any';

    const original = defined(
      defined(renderFrame(controller).cells[1])[SIDEBAR_WIDTH + 6],
    );

    move();
    await highlighted();

    assert.equal(controller.busy, false, 'hover does not block commands');
    assert.deepEqual(
      defined(children[0]).writes,
      [],
      'Ctrl hover never writes a mouse event or scrolls the source PTY',
    );
    assert.equal(controller.hoveredFileCells.length, file.length + 3);

    const frame = renderFrame(controller);
    for (const hit of controller.hoveredFileCells) {
      const style = defined(
        defined(frame.cells[hit.y + 1])[SIDEBAR_WIDTH + 1 + hit.x],
      ).style;

      assert.equal(style.fg, controller.theme.colors.accent);
      assert.equal(style.underline, true);
    }

    assert.deepEqual(
      defined(defined(source.snapshot().lines[0])[5]).style,
      original.style,
      'highlight does not modify the terminal buffer',
    );
    assert.equal(
      defined(defined(frame.cells[1])[SIDEBAR_WIDTH + 5]).style.underline,
      undefined,
      'the opening backtick is not highlighted',
    );

    move(false);

    assert.equal(controller.hoveredFileCells.length, 0);
    assert.deepEqual(
      defined(renderFrame(controller).cells[1])[SIDEBAR_WIDTH + 6],
      original,
    );

    move();
    await highlighted();
    controller.handle({ kind: 'modifiers', mods: { ...NO_MODS, ctrl: true } });

    assert.ok(
      controller.hoveredFileCells.length,
      'releasing another key while Ctrl stays held preserves hover',
    );

    controller.handle({ kind: 'modifiers', mods: NO_MODS });

    assert.equal(
      controller.hoveredFileCells.length,
      0,
      'reported Ctrl release clears hover without pointer movement',
    );

    move();
    await highlighted();
    move(true, 2, 3);

    assert.equal(
      controller.hoveredFileCells.length,
      0,
      'moving into the sidebar clears the link',
    );

    move();
    await highlighted();
    source.content = 'replacement output';

    assert.equal(
      controller.hoveredFileCells.length,
      0,
      'new terminal content cannot inherit an old highlight',
    );

    source.content = `See \`${file}:12\` here`;
    move();
    controller.selectAgent('p', 'b');
    await delay(20);

    assert.equal(
      controller.hoveredFileCells.length,
      0,
      'a late result cannot highlight another tab',
    );

    controller.selectAgent('p', 'a');
    move();
    move(false);
    await delay(20);

    assert.equal(
      controller.hoveredFileCells.length,
      0,
      'a late result cannot restore a cleared hover',
    );

    for (const target of [
      join(directory, 'missing.txt'),
      directory,
      join(directory, 'binary.txt'),
    ]) {
      if (target.endsWith('binary.txt')) {
        await writeFile(target, Buffer.from([0, 1, 2]));
      }

      source.content = target;
      move();
      await delay(20);

      assert.equal(controller.hoveredFileCells.length, 0, target);
    }

    source.content = file;
    delete process.env['EDITOR'];
    move();
    await delay(20);

    assert.equal(
      controller.hoveredFileCells.length,
      0,
      'no link is offered without a configured editor',
    );
  } finally {
    if (originalEditor === undefined) {
      delete process.env['EDITOR'];
    } else {
      process.env['EDITOR'] = originalEditor;
    }

    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

void test('Ctrl+click isolates the mouse gesture, opens an editor and returns to its source among several tabs', async () => {
  const { controller, manager, children } = setup();
  const directory = await mkdtemp(join(tmpdir(), 'ducks-controller-link-'));
  const file = join(directory, 'text.txt');
  const originalEditor = process.env['EDITOR'];

  const settle = async () => {
    while (controller.busy) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  const click = (ctrl: boolean, action = 3, buttons = 1) => {
    controller.handle({
      kind: 'mouse',
      x: SIDEBAR_WIDTH + 3,
      y: 1,
      action,
      buttons,
      wheelY: 0,
      mods: { ...NO_MODS, ctrl },
    });
  };

  try {
    await writeFile(file, 'hello\n');

    const source = defined(controller.session).screen as FakeScreen;
    source.content = file;
    source.modes.mouseTrackingMode = 'vt200';
    click(false);

    assert.equal(
      defined(children[0]).writes.length,
      1,
      'ordinary click still reaches the agent',
    );

    delete process.env['EDITOR'];
    click(true);
    await settle();
    click(false, 4, 0);

    assert.match(controller.message, /Set \$EDITOR/u);
    assert.equal(children.length, 3);
    assert.equal(
      defined(children[0]).writes.length,
      1,
      'Ctrl press and release never reach the source',
    );

    process.env['EDITOR'] = 'vim -R';
    click(true);
    await settle();

    assert.equal(children.length, 4);
    assert.notEqual(defined(controller.agent).id, 'a');
    assert.equal(controller.focus, 'terminal');

    (defined(controller.session).screen as FakeScreen).modes.mouseTrackingMode =
      'vt200';
    click(false, 4, 0);

    assert.deepEqual(
      defined(children[3]).writes,
      [],
      'release does not leak into the new editor',
    );

    defined(children[3]).exit();
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(
      controller.agent?.id,
      'a',
      'return to the clicked tab, rather than its next neighbour',
    );
    assert.deepEqual(
      defined(controller.place).agents.map((a) => a.id),
      ['a', 'b'],
    );

    await writeFile(file, Buffer.from([0, 1, 2]));
    click(true);
    await settle();
    click(false, 4, 0);

    assert.equal(children.length, 4, 'binary files do not launch an editor');

    source.content = join(directory, 'missing.txt');
    click(true);
    await settle();
    click(false, 4, 0);

    assert.equal(children.length, 4, 'missing files do not launch an editor');
  } finally {
    if (originalEditor === undefined) {
      delete process.env['EDITOR'];
    } else {
      process.env['EDITOR'] = originalEditor;
    }

    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

void test("Place changes restore that Place's selected agent; tab commands stay local", () => {
  const { controller, command } = setup();

  command('n');

  assert.equal(controller.agent?.id, 'b');

  controller.selectPlace('q');

  assert.equal(controller.agent.id, 'c');

  controller.selectPlace('p');

  assert.equal(controller.agent.id, 'b');

  command('n');

  assert.equal(controller.agent.id, 'a');
});

void test('startup automatically opens every saved tab as a shell, including legacy and background tabs', () => {
  const { config, controller, manager, children, launches } = setup();
  const shell = defined(config.profiles.find((p) => p.id === 'shell'));

  assert.deepEqual(launches, [
    { executable: shell.executable, directory: '/tmp' },
    { executable: shell.executable, directory: '/tmp' },
    { executable: shell.executable, directory: '/var' },
  ]);
  assert.ok(
    [...manager.sessions.values()].every((s) => s.status === 'running'),
  );
  assert.ok(
    config.places.every((p) => p.agents.every((a) => a.profileId === 'shell')),
  );

  controller.selectAgent('p', 'b');
  controller.restoreTerminals();

  assert.equal(
    children.length,
    3,
    'restoring twice must not launch duplicate processes',
  );
  assert.equal(controller.agent?.id, 'b');
  assert.equal(controller.focus, 'terminal');
});

void test('ordinary keys and paste only reach the focused active agent; Ctrl+B never leaks', () => {
  const { controller, children, key, command } = setup();

  command('n');
  controller.handle({ kind: 'text', text: 'hello' });
  key('c', true);
  controller.handle({ kind: 'paste', text: 'a\nb' });

  assert.deepEqual(defined(children[0]).writes, []);
  assert.deepEqual(defined(children[1]).writes, ['hello', '\x03', 'a\rb']);

  key('b', true);
  key('b', true);

  assert.equal(defined(children[1]).writes.at(-1), '\x02');

  command('?');

  assert.equal(defined(children[1]).writes.at(-1), '\x02');
});
void test('Ctrl+B digits select tabs by position within the current Place and preserve focus', async () => {
  const context = setup();
  const { config, controller, manager, children, key, command } = context;
  const place = defined(controller.place);
  place.agents.push(
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `tab-${i + 3}`,
      name: `Tab ${i + 3}`,
      profileId: 'shell',
    })),
  );

  try {
    for (const focus of ['terminal', 'sidebar'] as const) {
      controller.focus = focus;

      for (let number = 1; number <= 10; number++) {
        const digit = String(number % 10);
        const saved = context.saved;
        if (focus === 'terminal') {
          command(digit);
        } else {
          key('b', true);
          key(digit);
        }

        assert.equal(
          defined(controller.agent).id,
          defined(place.agents[number - 1]).id,
        );
        assert.equal(config.activePlaceId, place.id);
        assert.equal(controller.focus, focus);
        assert.equal(controller.prefix, false);
        assert.ok(context.saved > saved);
        assert.equal(
          controller.tree()[controller.treeIndex]?.agentId,
          defined(controller.agent).id,
        );
      }
    }

    controller.selectAgent(place.id, 'tab-11');
    command('0');

    assert.equal(
      defined(controller.agent).id,
      'tab-10',
      '0 always selects the tenth tab',
    );

    controller.selectPlace('q');
    command('1');

    assert.equal(defined(controller.agent).id, 'c');
    assert.equal(config.activePlaceId, 'q');
    assert.equal(
      place.activeAgentId,
      'tab-10',
      'other Places keep their selected tab',
    );
    assert.ok(children.every((child) => child.writes.length === 0));
  } finally {
    await manager.shutdown();
  }
});

void test('missing numbered tabs are ignored and digits without an active prefix reach the terminal', async () => {
  const context = setup();
  const { controller, manager, children, key, command } = context;

  try {
    command('2');

    const saved = context.saved;
    for (const digit of ['3', '9', '0']) {
      command(digit);

      assert.equal(controller.agent?.id, 'b');
      assert.equal(controller.prefix, false);
      assert.equal(context.saved, saved);
    }

    controller.handle({ kind: 'text', text: '1' });
    key('0');
    key('b', true);
    controller.prefixUntil = Date.now() - 1;
    key('2');
    controller.handle({ kind: 'paste', text: '1234567890' });

    assert.deepEqual(defined(children[1]).writes, [
      '1',
      '0',
      '2',
      '1234567890',
    ]);
    assert.equal(controller.agent?.id, 'b');
    assert.deepEqual(defined(children[0]).writes, []);

    const place = defined(controller.place);
    place.agents = [];
    place.activeAgentId = null;
    command('1');
    command('0');

    assert.equal(place.activeAgentId, null);
    assert.equal(context.saved, saved);

    controller.config.activePlaceId = null;
    command('1');

    assert.equal(controller.config.activePlaceId, null);
  } finally {
    await manager.shutdown();
  }
});

void test('shortcut help shows only Commands at 80 × 24, fits without scrolling and isolates terminal input', async () => {
  const context = setup();
  const { controller, manager, children, key, command } = context;

  try {
    controller.handle({ kind: 'text', text: '?' });

    assert.deepEqual(
      defined(children[0]).writes,
      ['?'],
      'bare ? is ordinary terminal input',
    );

    controller.handle({ kind: 'resize', cols: 80, rows: 24 });

    const configBefore = JSON.stringify(controller.config),
      saved = context.saved;

    command('?');

    assert.equal(controller.modal?.kind, 'help');
    assert.equal(controller.prefix, false);
    assert.match(renderFrame(controller).plainText(), /Keyboard shortcuts/u);

    const frame = renderFrame(controller).plainText();

    assert.match(frame, /Esc\/Enter · Close/u);
    assert.match(frame, /New Place with a shell/u);
    assert.match(frame, /Send literal Ctrl\+B/u);

    for (const navigation of ['home', 'up', 'pagedown', 'pageup', 'end']) {
      key(navigation);

      assert.equal(
        renderFrame(controller).plainText(),
        frame,
        'help fits without scrolling',
      );
    }

    controller.handle({ kind: 'resize', cols: 120, rows: 60 });

    assert.match(renderFrame(controller).plainText(), /Send literal Ctrl\+B/u);

    controller.handle({ kind: 'paste', text: 'hidden' });
    key('c', true);
    key('left');

    assert.equal(JSON.stringify(controller.config), configBefore);
    assert.equal(context.saved, saved);

    key('escape');

    assert.equal(Boolean(controller.modal), false);
    assert.equal(controller.focus, 'terminal');

    key('z');

    assert.deepEqual(defined(children[0]).writes, ['?', 'z']);

    controller.focus = 'sidebar';
    key('b', true);
    key('?');

    assert.equal(controller.modal.kind, 'help', 'key events also open help');

    key('enter');

    assert.equal(Boolean(controller.modal), false);
    assert.equal(controller.focus, 'sidebar');
  } finally {
    await manager.shutdown();
  }
});
void test('f searches visible names across all Places, including collapsed agents, and Enter focuses the match', async () => {
  const context = setup();
  const { controller, manager, children, key, command } = context;

  try {
    defined(manager.sessions.get('c')).threadName = 'Thread One';
    defined(manager.sessions.get('c')).processName = 'codex';
    controller.collapsed.add('q');

    const index = controller.treeIndex,
      agent = controller.agent?.id,
      saved = context.saved;

    command('f');

    assert.equal(controller.modal?.kind, 'search');
    assert.equal(controller.focus, 'terminal');
    assert.equal(controller.searchResults().length, 5);

    controller.handle({ kind: 'text', text: 'tHrEaD' });

    assert.deepEqual(controller.searchResults(), [
      { placeId: 'q', agentId: 'c', name: 'Thread One', placeName: 'Second' },
    ]);
    assert.match(
      renderFrame(controller).plainText(),
      /Agent · Thread One — Second/u,
    );
    assert.equal(controller.treeIndex, index);
    assert.equal(controller.agent?.id, agent);
    assert.equal(context.saved, saved);
    assert.ok(children.every((child) => child.writes.length === 0));

    key('enter');

    assert.equal(controller.modal, null);
    assert.equal(controller.place?.id, 'q');
    assert.equal(controller.agent?.id, 'c');
    assert.equal(controller.focus, 'terminal');
    assert.equal(controller.collapsed.has('q'), false);
    assert.deepEqual(controller.tree()[controller.treeIndex], {
      placeId: 'q',
      agentId: 'c',
    });

    controller.handle({ kind: 'text', text: 'selected agent' });

    assert.deepEqual(
      children.map((child) => child.writes),
      [[], [], ['selected agent']],
    );
  } finally {
    await manager.shutdown();
  }
});

void test('search cancels without side effects, handles no matches, and opens a Place with its remembered tab', async () => {
  const context = setup();
  const { controller, config, manager, children, key, command } = context;

  try {
    for (const focus of ['sidebar', 'terminal'] as const) {
      controller.focus = focus;

      const before = JSON.stringify(config),
        saved = context.saved;

      command('f');
      controller.handle({ kind: 'paste', text: 'missing\r\nname' });

      assert.ok(controller.modal?.kind === 'search');
      assert.equal(controller.modal.editor.text, 'missing name');
      assert.equal(controller.searchResults().length, 0);
      assert.match(renderFrame(controller).plainText(), /No matches/u);

      key('down');
      key('enter');

      assert.equal(controller.modal.kind, 'search');

      key('escape');

      assert.equal(controller.modal, null);
      assert.equal(controller.focus, focus);
      assert.equal(JSON.stringify(config), before);
      assert.equal(context.saved, saved);
    }

    command('f');

    assert.ok(controller.modal?.kind === 'search');
    assert.equal(controller.modal.editor.text, '');

    controller.handle({ kind: 'text', text: 'sECOND' });
    key('enter');

    assert.equal(controller.place?.id, 'q');
    assert.equal(controller.agent?.id, 'c');
    assert.equal(controller.focus, 'terminal');

    defined(config.places[1]).agents = [];
    defined(config.places[1]).activeAgentId = null;
    controller.selectAgent('p', 'a');
    command('f');
    controller.handle({ kind: 'text', text: 'Second' });
    key('enter');

    assert.equal(controller.place.id, 'q');
    assert.equal(controller.agent, undefined);
    assert.equal(controller.focus, 'sidebar');
    assert.ok(children.every((child) => child.writes.length === 0));
  } finally {
    await manager.shutdown();
  }
});

void test('search scrolls results, resets selection on edits, and keeps a long Unicode query cursor visible', async () => {
  const { controller, config, manager, key, command } = setup();

  try {
    config.places.push(
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `project-${i}`,
        name: `Project ${i}`,
        directory: '/tmp',
        agents: [],
        activeAgentId: null,
      })),
    );
    controller.handle({ kind: 'resize', cols: 80, rows: 24 });
    command('f');

    assert.ok(controller.modal?.kind === 'search');

    controller.handle({ kind: 'text', text: 'project' });
    key('pagedown');
    key('down');

    assert.equal(controller.modal.selected, 13);

    const dialog = renderFrame(controller)
      .plainText()
      .split('\n')
      .slice(2, 22)
      .map((line) => line.slice(4, 76))
      .join('\n');

    assert.match(dialog, /place · Project 13/u);
    assert.doesNotMatch(dialog, /place · Project 0\s/u);

    key('pageup');
    key('up');
    key('tab');

    assert.equal(controller.modal.selected, 1);

    controller.handle({ kind: 'text', text: ' 29' });

    assert.equal(controller.modal.selected, 0);
    assert.equal(controller.searchResults()[0]?.placeId, 'project-29');

    key('home');
    key('delete');

    assert.equal(controller.modal.editor.text, 'roject 29');

    key('end');
    key('backspace');

    assert.equal(controller.modal.editor.text, 'roject 2');

    controller.handle({ kind: 'paste', text: '世界🦆e\u0301'.repeat(30) });

    const frame = renderFrame(controller);
    const field = defined(frame.cells[5]).slice(6, 74);

    assert.ok(field.some((cell) => cell.style.inverse));
    assert.ok(
      field
        .map((cell) => cell.text)
        .join('')
        .trimEnd()
        .endsWith('世界🦆e\u0301'),
    );

    key('backspace');

    assert.ok(String(controller.modal.editor.text).endsWith('世界🦆'));

    controller.handle({ kind: 'resize', cols: 100, rows: 30 });

    assert.ok(
      renderFrame(controller).cells.some((row) =>
        row.some((cell) => cell.style.inverse),
      ),
    );

    key('escape');
    command('f');
    controller.handle({ kind: 'text', text: 'project' });
    key('pagedown');
    key('enter');

    assert.equal(controller.place?.id, 'project-12');
    assert.equal(controller.focus, 'sidebar');
  } finally {
    await manager.shutdown();
  }
});

void test('prompt edits multiline Unicode, keeps drafts per agent and sends only to its original target', async () => {
  const { controller, manager, children, key, command } = setup();

  try {
    defined(controller.session).screen.modes.bracketedPasteMode = true;
    defined(controller.session).threadName = 'Chosen agent';
    command('p');

    assert.equal(controller.modal?.kind, 'prompt');
    assert.match(
      renderFrame(controller).plainText(),
      /To: First \/ Chosen agent/u,
    );

    key('enter', true);
    controller.handle({ kind: 'text', text: 'first line' });
    key('enter');
    controller.handle({ kind: 'paste', text: 'вторая строка\r\n🦆' });
    key('backspace');
    controller.handle({ kind: 'text', text: 'готово' });
    key('c', true);

    assert.deepEqual(
      children.map((child) => child.writes),
      [[], [], []],
    );

    key('escape');

    assert.equal(Boolean(controller.modal), false);
    assert.equal(controller.focus, 'terminal');

    controller.selectAgent('p', 'b');
    command('p');

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Controller methods mutate modal despite prior type narrowing.
    assert.ok(controller.modal.kind === 'prompt');
    assert.equal(
      controller.modal.editor.text,
      '',
      'another agent has a separate draft',
    );

    key('escape');
    controller.selectAgent('p', 'a');
    command('p');

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Controller methods mutate modal despite prior type narrowing.
    assert.ok(controller.modal.kind === 'prompt');
    assert.equal(
      controller.modal.editor.text,
      'first line\nвторая строка\nготово',
    );

    controller.selectAgent('q', 'c');
    key('enter', true);

    assert.equal(Boolean(controller.modal), false);
    assert.deepEqual(
      children.map((child) => child.writes),
      [['\x1b[200~first line\nвторая строка\nготово\x1b[201~', '\r'], [], []],
    );
    assert.equal(controller.agent?.id, 'a');

    command('p');

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Controller methods mutate modal despite prior type narrowing.
    assert.ok(controller.modal.kind === 'prompt');
    assert.equal(
      controller.modal.editor.text,
      '',
      'successful send clears the draft',
    );

    key('escape');
  } finally {
    await manager.shutdown();
  }
});

void test('prompt cannot send to a neighbouring agent if its target exits, and long drafts keep their cursor visible after resize', async () => {
  const { controller, manager, children, key, command } = setup();

  try {
    command('p');
    controller.handle({
      kind: 'paste',
      text: Array.from(
        { length: 30 },
        (_, i) => `${i}: ${'界'.repeat(45)}`,
      ).join('\n'),
    });
    controller.handle({ kind: 'resize', cols: 80, rows: 24 });

    assert.ok(controller.modal?.kind === 'prompt');

    const frame = renderFrame(controller);

    assert.ok(controller.modal.editor.offset > 0);
    assert.match(frame.plainText(), /Ctrl\/Alt\+Enter · Send/u);
    assert.ok(
      frame.cells.some((row) => row.some((cell) => cell.style.inverse)),
      'editor cursor is visible',
    );

    key('home', true);
    renderFrame(controller);

    assert.equal(controller.modal.editor.offset, 0);

    defined(children[0]).exit();
    key('enter', true);

    assert.equal(controller.modal.kind, 'prompt');
    assert.match(controller.message, /no longer running/u);
    assert.deepEqual(
      children.map((child) => child.writes),
      [[], [], []],
    );

    key('escape');
    defined(children[1]).exit();
    command('p');

    assert.equal(Boolean(controller.modal), false);
    assert.match(controller.message, /Select a running agent/u);
  } finally {
    await manager.shutdown();
  }
});

void test('prompt editor navigates wrapped Unicode and deletes graphemes and line breaks correctly', () => {
  const editor = new PromptEditor();

  editor.insert('ab界🦆e\u0301\nsecond');
  editor.key('home', 6);
  editor.key('backspace', 6);

  assert.equal(
    editor.text,
    'ab界🦆e\u0301second',
    'Backspace at line start joins lines',
  );

  editor.key('backspace', 6);

  assert.equal(
    editor.text,
    'ab界🦆second',
    'combining sequence is removed together',
  );

  editor.key('left', 6);
  editor.key('delete', 6);

  assert.equal(editor.text, 'ab界second', 'Delete removes the entire emoji');

  editor.key('home', 6, true);
  editor.key('down', 6);

  assert.equal(editor.layout(6).row, 1);

  editor.key('up', 6);

  assert.equal(editor.cursor, 0);

  editor.key('home', 6);

  assert.equal(editor.cursor, 0);

  editor.key('end', 6, true);
  editor.key('enter', 6);
  editor.insert('third');

  assert.equal(editor.text, 'ab界second\nthird');

  const wrapped = new PromptEditor();

  wrapped.insert('abcd界界界\n123456');
  wrapped.key('up', 7);

  assert.equal(
    wrapped.layout(7).row,
    1,
    'Up can land at the end of a wrapped row',
  );

  wrapped.key('up', 7);

  assert.equal(
    wrapped.layout(7).row,
    0,
    'Up keeps moving across a shared wrap boundary',
  );
});

void test('dialogs isolate input; cancellation preserves agents and Enter confirms closing by default', async () => {
  const { controller, manager, children, key, command } = setup();

  try {
    command('z');

    assert.equal(controller.modal?.kind, 'menu');

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Controller methods mutate modal despite prior type narrowing.
    if (controller.modal.kind === 'menu') {
      assert.deepEqual(
        controller.modal.choices.map((choice) => choice.label),
        ['Confirm', 'Cancel'],
      );
      assert.equal(controller.modal.selected, 0);
    }

    controller.handle({ kind: 'text', text: 'secret' });
    key('c', true);

    assert.deepEqual(defined(children[0]).writes, []);

    key('escape');

    assert.equal(controller.modal, null);
    assert.equal(controller.place?.agents.length, 2);

    command('z');
    key('down');
    key('enter');

    assert.equal(controller.modal, null);
    assert.equal(controller.place.agents.length, 2);

    command('z');
    key('enter');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(controller.modal, null);
    assert.deepEqual(
      controller.place.agents.map((agent) => agent.id),
      ['b'],
    );
    assert.deepEqual([...manager.sessions.keys()], ['b', 'c']);
  } finally {
    await manager.shutdown();
  }
});

void test('closing a running Place requires confirmation and cancellation leaves every terminal open', async () => {
  const { controller, manager, children, key, command } = setup();

  try {
    key('d');

    assert.deepEqual(
      defined(children[0]).writes,
      ['d'],
      'd without the prefix remains terminal input',
    );

    command('x');

    assert.equal(
      controller.modal?.title,
      'Close this Place and all its terminals?',
    );
    assert.equal(controller.modal.kind, 'menu');

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Controller methods mutate modal despite prior type narrowing.
    if (controller.modal.kind === 'menu') {
      assert.deepEqual(
        controller.modal.choices.map((choice) => choice.label),
        ['Confirm', 'Cancel'],
      );
      assert.equal(controller.modal.selected, 0);
    }

    key('down');
    key('enter');

    assert.equal(controller.modal, null);

    command('x');
    key('escape');

    assert.equal(controller.config.places.length, 2);
    assert.ok(
      [...manager.sessions.values()].every((session) => session.process),
    );
    assert.deepEqual(
      controller.place?.agents.map((agent) => agent.id),
      ['a', 'b'],
    );
  } finally {
    await manager.shutdown();
  }
});

void test('closing a Place removes all its sessions and selects the next Place without stopping its terminal', async () => {
  const context = setup();
  const { controller, manager, config, children, key, command } = context;
  const screens = [
    defined(manager.sessions.get('a')).screen,
    defined(manager.sessions.get('b')).screen,
  ] as FakeScreen[];
  const saved = context.saved;

  controller.collapsed.add('p');

  try {
    command('x');
    key('enter');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(controller.modal, null);
    assert.equal(controller.busy, false);
    assert.deepEqual(
      config.places.map((place) => place.id),
      ['q'],
    );
    assert.equal(config.activePlaceId, 'q');
    assert.equal(controller.agent?.id, 'c');
    assert.equal(controller.focus, 'terminal');
    assert.deepEqual([...manager.sessions.keys()], ['c']);
    assert.ok(screens.every((screen) => screen.disposed));
    assert.equal(controller.collapsed.has('p'), false);
    assert.equal(manager.sessions.get('c')?.status, 'running');
    assert.ok(context.saved > saved);
    assert.equal(parseConfig(config).activePlaceId, 'q');

    controller.handle({ kind: 'text', text: 'surviving terminal' });

    assert.deepEqual(defined(children[2]).writes, ['surviving terminal']);
  } finally {
    await manager.shutdown();
  }
});

void test('closing an empty Place needs no confirmation, selects the previous Place and allows removing the last Place', async () => {
  const { controller, manager, config, children, key, command } = setup();

  try {
    controller.selectPlace('q');
    defined(children[2]).exit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    command('x');

    assert.equal(controller.modal, null);

    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(config.activePlaceId, 'p');
    assert.equal(controller.focus, 'sidebar');

    command('x');
    key('enter');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(config.places, []);
    assert.equal(config.activePlaceId, null);
    assert.equal(controller.focus, 'sidebar');
    assert.equal(manager.sessions.size, 0);
    assert.match(renderFrame(controller).plainText(), /Open your first Place/u);

    command('x');

    assert.equal(
      controller.modal,
      null,
      'closing when no Place exists is harmless',
    );

    command('s');

    const deadline = Date.now() + 2000;
    while (controller.busy) {
      assert.ok(Date.now() < deadline, 'new Place command completes');

      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(config.places.length, 1);
    assert.equal(controller.session?.status, 'running');
    assert.equal(controller.focus, 'terminal');
  } finally {
    await manager.shutdown();
  }
});

void test('a Place remains available if a terminal cannot be stopped, while successfully closed tabs are removed', async () => {
  const { controller, manager, config, key, command } = setup();
  const remove = manager.remove.bind(manager);

  manager.remove = async (id) => {
    if (id === 'b') {
      throw new Error('cannot stop terminal');
    }

    await remove(id);
  };

  try {
    command('x');
    key('enter');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(controller.message, 'cannot stop terminal');
    assert.equal(controller.busy, false);
    assert.equal(config.places.length, 2);
    assert.equal(config.activePlaceId, 'p');
    assert.deepEqual(
      controller.place?.agents.map((agent) => agent.id),
      ['b'],
    );
    assert.equal(controller.agent?.id, 'b');
    assert.equal(manager.sessions.has('a'), false);
    assert.equal(manager.sessions.get('b')?.status, 'running');
    assert.equal(manager.sessions.get('c')?.status, 'running');
  } finally {
    await manager.shutdown();
  }
});

void test('one-line theme selector previews immediately, saves on Enter and restores on Escape without restarting terminals', () => {
  const context = setup();
  const { controller, config, children, key, command } = context;
  const selectedAgent = defined(controller.agent).id;

  command('m');

  assert.equal(controller.modal?.title, 'Settings');
  assert.match(
    renderFrame(controller).plainText(),
    /Theme\s+‹\s+Catppuccin Mocha · Dark/u,
  );
  assert.doesNotMatch(
    renderFrame(controller).plainText(),
    /Dracula|Solarized Light/u,
  );

  const saved = context.saved;

  key('right');
  key('right');
  key('right');

  assert.equal(controller.theme.id, 'catppuccin-latte');
  assert.equal(
    config.theme,
    'catppuccin-mocha',
    'preview never changes persisted preferences',
  );
  assert.equal(context.saved, saved);

  const light = controller.theme;
  const frame = renderFrame(controller);

  assert.equal(
    defined(defined(frame.cells[0])[0]).style.bg,
    light.colors.sidebar,
  );
  assert.equal(
    defined(defined(frame.cells[1])[SIDEBAR_WIDTH + 1]).style.bg,
    light.colors.bg,
  );
  assert.match(frame.plainText(), /Catppuccin Latte · Light/u);

  controller.handle({ kind: 'paste', text: 'hidden' });
  key('c', true);

  assert.deepEqual(defined(children[0]).writes, []);
  assert.equal(children.length, 3);
  assert.equal(defined(controller.agent).id, selectedAgent);

  key('enter');

  assert.equal(config.theme, 'catppuccin-latte');
  assert.ok(context.saved > saved);

  command('m');
  renderFrame(controller);

  const hit = defined(controller.modalHits[1]); // next theme

  controller.handle({
    kind: 'mouse',
    x: hit.rect.x + 1,
    y: hit.rect.y,
    action: 3,
    buttons: 1,
    wheelY: 0,
    mods: NO_MODS,
  });

  assert.equal(controller.theme.id, 'github-light');
  assert.equal(config.theme, 'catppuccin-latte');

  key('escape');

  assert.equal(Boolean(controller.modal), false);
  assert.equal(
    controller.theme.id,
    'catppuccin-latte',
    'cancel restores the original theme',
  );

  command('m');

  assert.equal(controller.theme.id, 'catppuccin-latte');

  key('right');
  key('right');
  key('right');

  assert.equal(
    controller.theme.id,
    'catppuccin-mocha',
    'selection wraps at the end',
  );

  key('left');

  assert.equal(
    controller.theme.id,
    'solarized-light',
    'selection wraps at the beginning',
  );

  key('escape');

  assert.equal(config.theme, 'catppuccin-latte');

  controller.handle({ kind: 'text', text: 'echo ready' });

  assert.deepEqual(defined(children[0]).writes, ['echo ready']);
});
void test('mouse activates a tab; scroll history does not write to the child', () => {
  const { controller, children, command, key } = setup();

  command('n');
  renderFrame(controller);

  const hit = defined(controller.tabHits[0]);

  controller.handle({
    kind: 'mouse',
    x: hit.rect.x + 1,
    y: hit.rect.y,
    action: 3,
    buttons: 1,
    wheelY: 0,
    mods: NO_MODS,
  });

  assert.equal(controller.agent?.id, 'a');
  assert.equal(controller.focus, 'terminal');

  key('pageup', false, true);

  assert.ok((controller.session?.screen as FakeScreen).offset > 0);
  assert.deepEqual(defined(children[0]).writes, []);
});
void test('wheel scrolls terminal history and mouse-aware programs in the requested direction', async () => {
  const { controller, manager, children } = setup();
  const screen = defined(controller.session).screen as FakeScreen;
  const wheel = wheelInput(controller);

  try {
    wheel(-2);

    assert.equal(screen.offset, 6, 'up moves into earlier terminal history');

    wheel(1);

    assert.equal(screen.offset, 3, 'down moves towards live terminal output');

    screen.modes.mouseTrackingMode = 'vt200';
    wheel(1, true);

    assert.equal(
      screen.offset,
      0,
      'Shift+wheel uses the same direction for history',
    );
    assert.deepEqual(
      defined(children[0]).writes,
      [],
      'history scrolling is not forwarded to the child',
    );

    wheel(1);
    wheel(-1);

    assert.deepEqual(defined(children[0]).writes, [
      '\x1b[<65;2;2M',
      '\x1b[<64;2;2M',
    ]);
  } finally {
    await manager.shutdown();
  }
});

void test('wheel emulates cursor keys only on an alternate screen without mouse tracking', async () => {
  const { controller, manager, children } = setup();
  const screen = defined(controller.session).screen as FakeScreen;
  const wheel = wheelInput(controller);

  try {
    screen.modes.alternateScreen = true;
    wheel(1);
    wheel(-2);

    assert.deepEqual(defined(children[0]).writes, [
      '\x1b[B'.repeat(3),
      '\x1b[A'.repeat(6),
    ]);
    assert.equal(
      screen.offset,
      0,
      'alternate screen wheel input goes to the program',
    );

    defined(children[0]).writes.length = 0;
    screen.modes.applicationCursorKeys = true;
    wheel(1);
    wheel(-1);

    assert.deepEqual(
      defined(children[0]).writes,
      ['\x1bOB'.repeat(3), '\x1bOA'.repeat(3)],
      'nano uses application cursor keys',
    );

    defined(children[0]).writes.length = 0;
    wheel(0);
    screen.modes.alternateScroll = false;
    wheel(1);
    wheel(-1, true);

    assert.deepEqual(
      defined(children[0]).writes,
      [],
      'horizontal wheel, disabled alternate scroll and Shift never synthesize keys',
    );

    screen.modes.mouseTrackingMode = 'vt200';
    wheel(1);

    assert.deepEqual(
      defined(children[0]).writes,
      ['\x1b[<65;2;2M'],
      'explicit mouse tracking takes priority',
    );

    defined(children[0]).writes.length = 0;
    screen.modes.mouseTrackingMode = 'none';
    screen.modes.alternateScreen = false;
    wheel(-1);

    assert.deepEqual(
      defined(children[0]).writes,
      [],
      'returning to the normal screen restores history scrolling',
    );
    assert.equal(screen.offset, 3);
  } finally {
    await manager.shutdown();
  }
});

void test('wheel direction is consistent in the Place tree and settings', async () => {
  const { controller, config, manager, command } = setup();
  for (let i = 0; i < 40; i++) {
    config.places.push({
      id: `extra-${i}`,
      name: `Place ${i}`,
      directory: '/tmp',
      agents: [],
      activeAgentId: null,
    });
  }

  const wheel = (wheelY: number) => {
    controller.handle({
      kind: 'mouse',
      x: 1,
      y: 3,
      action: 5,
      buttons: 0,
      wheelY,
      mods: NO_MODS,
    });
  };

  try {
    wheel(1);

    assert.equal(controller.treeOffset, 3);

    wheel(-1);

    assert.equal(controller.treeOffset, 0);

    const original = controller.theme.id;

    command('m');
    wheel(1);

    assert.equal(controller.theme.id, defined(THEMES[1]).id);

    wheel(-1);

    assert.equal(controller.theme.id, original);
  } finally {
    await manager.shutdown();
  }
});
void test('small windows keep agents alive and show a clear message', () => {
  const { controller, children } = setup();

  controller.handle({ kind: 'resize', cols: 60, rows: 12 });

  assert.match(renderFrame(controller).plainText(), /Increase terminal/);

  controller.handle({ kind: 'text', text: 'x' });

  assert.deepEqual(defined(children[0]).writes, []);
  assert.equal(controller.session?.status, 'running');
});
void test('adding a symlink of an existing Place selects it instead of duplicating it', async () => {
  const { controller } = setup();
  const directory = await mkdtemp(join(tmpdir(), 'ducks-controller-'));

  try {
    const first = await controller.addPlace(directory);

    await symlink(directory, join(directory, 'link'));

    const next = await controller.addPlace(join(directory, 'link'));

    assert.equal(first.id, next.id);
    assert.equal(controller.config.places.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
void test('rendered UI shows agent activity as colored indicators without status labels in tabs', () => {
  const { controller, manager } = setup();
  const text = renderFrame(controller).plainText();

  assert.doesNotMatch(text, /PLACES|Running|Starting|Stopped|Exited|■/);
  assert.match(text, /First/);
  assert.match(text, /Ctrl\+B/);
  assert.equal(controller.tabHits.length, 2);

  defined(manager.sessions.get('a')).activity = 'working';
  defined(manager.sessions.get('a')).processName = 'codex';
  defined(manager.sessions.get('b')).activity = 'waiting';
  defined(manager.sessions.get('b')).processName = 'claude';
  defined(manager.sessions.get('b')).threadName = 'Thread One';

  let frame = renderFrame(controller, 0);
  const sidebar = frame.cells
    .map((row) =>
      row
        .slice(0, SIDEBAR_WIDTH)
        .map((cell) => cell.text)
        .join(''),
    )
    .join('\n');

  assert.match(sidebar, /■ Thread One/u);
  assert.match(sidebar, /■ codex/u);
  assert.doesNotMatch(sidebar, /Claude|Working|Idle|Waiting/u);
  assert.equal(
    defined(defined(controller.place).agents[1]).name,
    'Claude',
    'thread labels never overwrite saved terminal definitions',
  );

  const tabs = defined(frame.cells[0])
    .slice(SIDEBAR_WIDTH + 1)
    .map((cell) => cell.text)
    .join('');

  assert.match(tabs, /■ codex\s+■ claude/u);
  assert.doesNotMatch(tabs, /Thread One|Working|Idle|Waiting for input/u);

  const indicator = (agentId: string) => {
    const hit = defined(
      controller.tabHits.find((hit) => hit.agentId === agentId),
    );

    return defined(defined(frame.cells[hit.rect.y])[hit.rect.x + 1]);
  };

  assert.equal(indicator('a').style.fg, controller.theme.colors.yellow);

  const peakColor = indicator('a').style.fg;

  assert.equal(indicator('b').style.fg, controller.theme.colors.red);

  frame = renderFrame(controller, 100);

  assert.equal(indicator('a').text, '■');
  assert.notEqual(
    indicator('a').style.fg,
    peakColor,
    'only brightness changes between animation frames',
  );
  assert.equal(
    defined(defined(frame.cells[2])[2]).text,
    indicator('a').text,
    'sidebar and tab share the animation phase',
  );
  assert.equal(
    defined(defined(frame.cells[2])[2]).style.fg,
    indicator('a').style.fg,
    'sidebar and tab share pulse brightness',
  );
  assert.equal(
    indicator('b').text,
    '■',
    'waiting status remains a steady square',
  );
  assert.equal(indicator('b').style.fg, controller.theme.colors.red);

  defined(manager.sessions.get('b')).activity = 'idle';
  frame = renderFrame(controller);

  assert.equal(indicator('b').style.fg, controller.theme.colors.green);
  assert.equal(indicator('b').text, '■');
  assert.equal(defined(defined(frame.cells[3])[2]).text, '■');
  assert.equal(
    defined(defined(frame.cells[3])[2]).style.fg,
    controller.theme.colors.green,
  );

  controller.handle({ kind: 'resize', cols: 80, rows: 24 });
  controller.selectAgent('p', 'b');
  renderFrame(controller);

  assert.ok(
    controller.tabHits.some((hit) => hit.agentId === 'b'),
    'active tab stays visible in a narrow window',
  );
});

void test('overflowing tabs keep the selected terminal visible and clickable at either end of the list', async () => {
  const { controller, manager } = setup();
  const place = defined(controller.place);
  for (let i = 0; i < 40; i++) {
    place.agents.push({
      id: `extra-${i}`,
      name: i % 2 ? '世界🦆' : 'a-long-terminal-name',
      profileId: 'codex',
    });
  }

  try {
    controller.handle({ kind: 'resize', cols: 80, rows: 24 });

    for (const id of ['extra-39', 'extra-20', 'a']) {
      controller.selectAgent(place.id, id);
      renderFrame(controller);

      const hit = defined(controller.tabHits.find((hit) => hit.agentId === id));

      assert.ok(hit.rect.x >= SIDEBAR_WIDTH + 1);
      assert.ok(hit.rect.x + hit.rect.w < controller.cols);

      controller.handle({
        kind: 'mouse',
        x: hit.rect.x + 1,
        y: hit.rect.y,
        action: 3,
        buttons: 1,
        wheelY: 0,
        mods: NO_MODS,
      });

      assert.equal(controller.agent?.id, id);
      assert.equal(controller.focus, 'terminal');
    }
  } finally {
    await manager.shutdown();
  }
});

void test('each Place shows its own Git branch in the sidebar, including collapsed background Places', async () => {
  const { config, manager } = setup();
  const git = new GitBranches(
    () => {
      /* Test stub. */
    },
    (directory) => Promise.resolve(directory === '/tmp' ? 'main' : 'feature/x'),
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
    git,
  );

  await git.refresh(config.places);
  controller.collapsed.add('q');

  const frame = renderFrame(controller);
  const sidebar = frame.cells
    .map((row) =>
      row
        .slice(0, SIDEBAR_WIDTH)
        .filter((cell) => cell.width)
        .map((cell) => cell.text)
        .join(''),
    )
    .join('\n');

  assert.match(sidebar, /First\s+main/u);
  assert.match(sidebar, /Second\s+feature\/x/u);

  git.dispose();
});

void test('exiting the active tab closes it, selects a neighbour and persists the removal', async () => {
  const context = setup();
  const { controller, manager, children, command } = context;

  command('n');

  const screen = defined(controller.session).screen as FakeScreen;
  const saved = context.saved;

  defined(children[1]).exit(0);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(controller.agent?.id, 'a');
  assert.equal(controller.focus, 'terminal');
  assert.deepEqual(
    controller.place?.agents.map((a) => a.id),
    ['a'],
  );
  assert.equal(manager.sessions.has('b'), false);
  assert.equal(screen.disposed, true);
  assert.ok(context.saved > saved);
  assert.deepEqual(
    parseConfig(controller.config).places[0]?.agents.map((a) => a.id),
    ['a'],
  );

  controller.handle({ kind: 'text', text: 'still running' });

  assert.deepEqual(defined(children[0]).writes, ['still running']);
});

void test('background and failing process exits close their own tabs without changing the current Place', async () => {
  const { controller, manager, children, command } = setup();

  command('n');
  controller.selectPlace('q');
  defined(children[0]).exit(7);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(controller.place?.id, 'q');
  assert.equal(controller.agent?.id, 'c');
  assert.equal(manager.sessions.has('a'), false);
  assert.equal(controller.config.places[0]?.activeAgentId, 'b');
  assert.deepEqual(
    controller.config.places[0].agents.map((a) => a.id),
    ['b'],
  );
});

void test('the last shell exit leaves an empty Place that can open another terminal', async () => {
  const { controller, manager, children, command } = setup();

  controller.selectPlace('q');
  defined(children[2]).exit();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(controller.place?.id, 'q');
  assert.equal(controller.place.activeAgentId, null);
  assert.equal(controller.place.agents.length, 0);
  assert.equal(controller.focus, 'sidebar');
  assert.equal(manager.sessions.has('c'), false);

  command('a');

  assert.equal(controller.place.agents.length, 1);
  assert.equal(controller.session?.status, 'running');
  assert.equal(controller.focus, 'terminal');
  assert.equal(controller.modal, null);
});

void test('new Places open shells; new terminals inherit cd without a profile or name dialog', async () => {
  const config = defaultConfig();
  const directory = await mkdtemp(join(tmpdir(), 'ducks-shell-place-'));
  const project = join(directory, 'project');

  await mkdir(project);

  let cwd = directory;
  const launches: { executable: string; cwd: string }[] = [];
  const manager = new SessionManager(
    (profile, cwd) => {
      launches.push({ executable: profile.executable, cwd });

      return new FakePty();
    },
    (c, r) => new FakeScreen(c, r),
    () => {
      /* Test stub. */
    },
    () => {
      /* Test stub. */
    },
    0,
    () => Promise.resolve(cwd),
  );

  let saved = 0;
  const controller = new Controller(
    config,
    manager,
    {
      save: () => {
        saved++;

        return Promise.resolve();
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

  const command = (text: string) => {
    controller.handle({
      kind: 'key',
      key: 'b',
      mods: { ...NO_MODS, ctrl: true },
    });
    controller.handle({ kind: 'text', text });
  };

  try {
    const first = await controller.createPlace(directory, 'My workspace');
    const second = await controller.createPlace(directory);

    assert.notEqual(first.id, second.id);
    assert.equal(controller.modal, null);
    assert.equal(controller.focus, 'terminal');
    assert.equal(first.agents[0]?.kind, 'shell');
    assert.equal(
      manager.sessions.get(defined(first.activeAgentId))?.status,
      'running',
    );
    assert.equal(
      manager.sessions.get(defined(second.activeAgentId))?.status,
      'running',
    );
    assert.equal(
      parseConfig(config).places.length,
      2,
      'two shells may start in the same directory',
    );

    const savesBeforeCd = saved;

    cwd = project;
    await manager.refreshDirectory(defined(second.activeAgentId));

    assert.equal(second.directory, project);
    assert.equal(second.name, 'project');
    assert.ok(saved > savesBeforeCd);
    assert.equal(parseConfig(config).places[1]?.agents[0]?.kind, 'shell');

    command('a');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(launches.at(-1), {
      executable: defined(config.profiles.find((p) => p.id === 'shell'))
        .executable,
      cwd: project,
    });
    assert.equal(controller.focus, 'terminal');
    assert.equal(controller.modal, null);
    assert.equal(controller.agent?.name, 'Shell 2');
    assert.equal(controller.session?.status, 'running');

    const previousAgentId = controller.agent.id;

    command('a');
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(controller.agent.name, 'Shell 3');
    assert.notEqual(controller.agent.id, previousAgentId);
    assert.equal(second.agents.length, 3);
    assert.equal(controller.modal, null);

    const persisted = parseConfig(config);

    assert.equal(persisted.places[1]?.autoName, true);

    cwd = directory;
    await manager.refreshDirectory(defined(second.agents[0]).id);

    assert.equal(second.directory, directory);
    assert.equal(
      second.name,
      directory.split('/').at(-1),
      'automatic names follow cd',
    );

    await manager.refreshDirectory(first.agents[0].id);

    assert.equal(first.name, 'My workspace', 'saved custom names survive cd');
    assert.equal(
      first.directory,
      directory,
      'background Places are independent',
    );
  } finally {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});

function wheelInput(
  controller: Controller,
): (wheelY: number, shift?: boolean) => void {
  return (wheelY: number, shift = false) => {
    controller.handle({
      kind: 'mouse',
      x: SIDEBAR_WIDTH + 2,
      y: 2,
      action: 5,
      buttons: 0,
      wheelY,
      mods: { ...NO_MODS, shift },
    });
  };
}

void test('drag selects only terminal text, copies on release and preserves the captured output', () => {
  const copies: string[] = [];
  const { controller, children, key } = setup((text) => copies.push(text));
  const source = defined(controller.session).screen as FakeScreen;
  source.content = 'hello world\nsecond line';

  const mouse = (action: number, x: number, y = 1, buttons = 1) => {
    controller.handle({
      kind: 'mouse',
      action,
      x: SIDEBAR_WIDTH + 1 + x,
      y,
      buttons,
      wheelY: 0,
      mods: NO_MODS,
    });
  };

  mouse(3, 0);
  mouse(2, 4);

  assert.equal(controller.terminalSelection?.text, 'hello');

  const frame = renderFrame(controller);

  assert.equal(
    frame.cells[1]?.[SIDEBAR_WIDTH + 1]?.style.bg,
    controller.theme.colors.accent,
  );
  assert.equal(
    frame.cells[1][SIDEBAR_WIDTH + 6]?.style.bg,
    controller.theme.colors.bg,
  );

  source.content = 'changed output';
  mouse(4, 4, 1, 0);

  assert.deepEqual(copies, ['hello']);
  assert.deepEqual(defined(children[0]).writes, []);
  assert.equal(
    renderFrame(controller).cells[1]?.[SIDEBAR_WIDTH + 1]?.text,
    'h',
  );

  key('c', true);

  assert.deepEqual(copies, ['hello', 'hello']);
  assert.equal(controller.terminalSelection, null);
  assert.deepEqual(defined(children[0]).writes, []);

  key('c', true);

  assert.deepEqual(defined(children[0]).writes, ['\x03']);

  mouse(3, 0);
  mouse(4, 0, 1, 0);

  assert.equal(
    controller.terminalSelection,
    null,
    'a click alone does not copy or freeze the screen',
  );
  assert.equal(copies.length, 2);
});

void test('selection overrides child mouse tracking only with a modifier and captures release outside the pane', () => {
  const copies: string[] = [];
  const { controller, children, key } = setup((text) => copies.push(text));
  const source = defined(controller.session).screen as FakeScreen;
  source.content = 'hello world';
  source.modes.mouseTrackingMode = 'any';

  const mouse = (action: number, x: number, alt = false, buttons = 1) => {
    controller.handle({
      kind: 'mouse',
      action,
      x,
      y: 1,
      buttons,
      wheelY: 0,
      mods: { ...NO_MODS, alt },
    });
  };

  mouse(3, SIDEBAR_WIDTH + 1);
  mouse(2, SIDEBAR_WIDTH + 5);
  mouse(4, SIDEBAR_WIDTH + 5, false, 0);

  assert.equal(controller.terminalSelection, null);
  assert.equal(defined(children[0]).writes.length, 3);

  mouse(3, SIDEBAR_WIDTH + 5, true);
  mouse(2, 1, true);
  mouse(4, 1, false, 0);

  assert.deepEqual(copies, ['hello']);
  assert.equal(controller.focus, 'terminal');
  assert.equal(defined(children[0]).writes.length, 3);

  key('escape');

  assert.equal(controller.terminalSelection, null);
  assert.equal(defined(children[0]).writes.length, 3);

  mouse(3, SIDEBAR_WIDTH + 1, true);
  mouse(2, SIDEBAR_WIDTH + 5, true);
  controller.selectAgent('p', 'b');

  assert.equal(controller.terminalSelection, null);

  controller.selectAgent('p', 'a');

  assert.equal(controller.terminalSelection, null);

  mouse(3, SIDEBAR_WIDTH + 1, true);
  mouse(2, SIDEBAR_WIDTH + 5, true);
  controller.handle({ kind: 'resize', cols: 120, rows: 35 });

  assert.equal(controller.terminalSelection, null);
});
