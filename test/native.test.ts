import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { measureTextCells } from '@rezi-ui/core';
import { defined } from '../src/defined.js';
import { readProcessDirectory } from '../src/terminal/directory.js';
import { fileCandidates, fileLinkAt } from '../src/terminal/files.js';
import { createScreen, spawnPty } from '../src/terminal/native.js';
import { signalGroup } from '../src/terminal/processes.js';
import { SessionManager } from '../src/terminal/SessionManager.js';
import { TerminalSelection } from '../src/terminal/TerminalSelection.js';
import { XtermScreen } from '../src/terminal/XtermScreen.js';
import { DEFAULT_THEME, THEMES } from '../src/themes.js';
import { AGENT_FIXTURE } from './helpers.js';
import type { TerminalScreen } from '../src/terminal/contracts.js';
import type { Theme } from '../src/themes.js';

function write(screen: TerminalScreen, text: string): Promise<void> {
  return new Promise((resolve) => {
    screen.write(text, resolve);
  });
}

function text(screen: TerminalScreen): string {
  return screen
    .snapshot()
    .lines.map((line) =>
      line
        .filter((cell) => cell.width > 0)
        .map((cell) => cell.text)
        .join(''),
    )
    .join('\n');
}

async function until(condition: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for terminal state');
    }

    await delay(10);
  }
}

void test('file hit testing follows wrapped lines, wide Unicode cells and the scrolled viewport', async () => {
  const screen = new XtermScreen(20, 4);

  try {
    const file = 'src/very-long-file-name.ts';

    await write(screen, `世界 ${file}\r\nline2\r\nline3\r\nline4`);
    screen.scroll(1);

    assert.ok(fileCandidates(screen.textAt(8, 0)).includes(file));
    assert.ok(fileCandidates(screen.textAt(2, 1)).includes(file));

    const position = defined(screen.textAt(8, 0));
    const link = defined(fileLinkAt(position));
    const hits = position.cells.filter(
      (cell) => cell.index < link.end && cell.index + cell.length > link.start,
    );

    assert.equal(hits.length, file.length);
    assert.deepEqual(
      hits[0],
      { x: 5, y: 0, width: 1, index: 3, length: 1 },
      'wide cells before the path affect columns, rather than string indices',
    );
    assert.equal(hits.at(-1)?.y, 1, 'the highlight spans wrapped rows');

    screen.scrollToBottom();

    assert.ok(
      fileCandidates(screen.textAt(2, 0)).includes(file),
      'the start of a wrapped link may be outside the viewport',
    );
    assert.ok(
      defined(screen.textAt(2, 0)).cells.every(
        (cell) => cell.y >= 0 && cell.y < screen.rows,
      ),
      'only visible cells can be highlighted',
    );
    assert.equal(screen.textAt(-1, 0), null);
    assert.equal(screen.textAt(0, 4), null);

    const wideFile = 'a'.repeat(19) + '界.txt';

    await write(screen, '\x1bc' + wideFile);

    const widePosition = defined(screen.textAt(0, 1));

    assert.ok(
      fileCandidates(widePosition).includes(wideFile),
      'wide glyph wrap padding does not split a file path',
    );
    assert.deepEqual(
      widePosition.cells.find((cell) => cell.x === 0 && cell.y === 1),
      { x: 0, y: 1, width: 2, index: 19, length: 1 },
    );

    await write(screen, '\x1b[?1049h\x1b[Hother.txt');

    assert.deepEqual(fileCandidates(screen.textAt(2, 0)), ['other.txt']);
  } finally {
    screen.dispose();
  }
});

void test('xterm handles ANSI cells, cursor visibility, terminal replies and alternate screen', async () => {
  const screen = new XtermScreen(40, 8);

  try {
    const replies: string[] = [];

    screen.onResponse((data) => replies.push(data));
    await write(screen, 'normal\r\n\x1b[38;2;255;0;0mПривет 世界\x1b[0m');

    assert.match(text(screen), /Привет 世界/);
    assert.equal(screen.snapshot().lines[1]?.[0]?.style.fg, 0xff0000);

    await write(screen, '\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[6n');

    assert.equal(screen.snapshot().cursor.visible, false);
    assert.equal(screen.modes.bracketedPasteMode, true);
    assert.equal(screen.modes.mouseTrackingMode, 'vt200');
    assert.equal(screen.modes.mouseEncoding, 'sgr');
    // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
    assert.ok(replies.some((data) => /\x1b\[\d+;\d+R/u.test(data)));

    await write(screen, '\x1b[?1049h\x1b[Halternate');

    assert.match(text(screen), /alternate/);

    await write(screen, '\x1b[?1049l');

    assert.match(text(screen), /normal/);

    screen.resize(60, 12);

    assert.equal(screen.cols, 60);
    assert.equal(screen.rows, 12);
  } finally {
    screen.dispose();
  }
});

void test('child OSC 52 writes survive chunk boundaries and go only to the host', async () => {
  const host: string[] = [];
  const replies: string[] = [];
  const screen = new XtermScreen(40, 8, undefined, (data) => host.push(data));
  screen.onResponse((data) => replies.push(data));

  const encoded = Buffer.from('Привет 世界 🦆\nsecond line').toString('base64');

  try {
    await write(screen, 'before\x1b]5');
    await write(screen, `2;c;${encoded.slice(0, 7)}`);

    assert.deepEqual(host, [], 'wait for a complete OSC sequence');

    await write(screen, `${encoded.slice(7)}\x07after`);
    // Exercise an ST terminator split across PTY chunks as well as BEL.
    await write(screen, `\x1b]52;p;${encoded}\x1b`);
    await write(screen, '\\');

    assert.deepEqual(host, [
      `\x1b]52;c;${encoded}\x07`,
      `\x1b]52;p;${encoded}\x07`,
    ]);
    assert.match(text(screen), /^beforeafter/);
    assert.deepEqual(replies, [], 'clipboard writes are not PTY input');

    await write(screen, '\x1b]52;c;?\x07');
    await write(screen, '\x1b]52;invalid;YQ==\x07');
    await write(screen, '\x1b]52;c;invalid!\x07');

    assert.equal(host.length, 2, 'ignore read queries and malformed writes');
  } finally {
    screen.dispose();
  }
});

void test('alternate screen and wheel-to-arrow mode follow terminal escape sequences', async () => {
  const screen = new XtermScreen(40, 8);

  try {
    assert.equal(screen.modes.alternateScreen, false);
    assert.equal(screen.modes.alternateScroll, true);

    for (const mode of [47, 1047, 1049]) {
      await write(screen, `\x1b[?${mode}h`);

      assert.equal(screen.modes.alternateScreen, true);

      await write(screen, `\x1b[?${mode}l`);

      assert.equal(screen.modes.alternateScreen, false);
    }

    await write(screen, '\x1b[?1007l');

    assert.equal(screen.modes.alternateScroll, false);

    await write(screen, '\x1b[?1007h');

    assert.equal(screen.modes.alternateScroll, true);

    await write(screen, '\x1b[?1007l\x1bc');

    assert.equal(
      screen.modes.alternateScroll,
      true,
      'a terminal reset restores wheel emulation',
    );
  } finally {
    screen.dispose();
  }
});

void test("terminal reports the current theme's default and indexed colors to applications", async () => {
  let theme: Theme = DEFAULT_THEME;
  const screen = new XtermScreen(20, 4, () => theme);
  const replies: string[] = [];

  screen.onResponse((data) => replies.push(data));

  const rgb = (color: number) =>
    [16, 8, 0]
      .map((shift) =>
        ((color >> shift) & 255).toString(16).padStart(2, '0').repeat(2),
      )
      .join('/');

  try {
    for (const next of THEMES) {
      theme = next;
      replies.length = 0;
      await write(
        screen,
        '\x1b]10;?\x07\x1b]11;?\x1b\\\x1b]12;?\x07\x1b]4;1;?;196;?\x07',
      );

      assert.deepEqual(replies, [
        `\x1b]10;rgb:${rgb(theme.colors.fg)}\x1b\\`,
        `\x1b]11;rgb:${rgb(theme.colors.bg)}\x1b\\`,
        `\x1b]12;rgb:${rgb(theme.colors.fg)}\x1b\\`,
        `\x1b]4;1;rgb:${rgb(defined(theme.ansi[1]))}\x1b\\`,
        '\x1b]4;196;rgb:ffff/0000/0000\x1b\\',
      ]);
    }

    replies.length = 0;
    await write(screen, '\x1b]10;?;?\x07\x1b]4;256;?\x07\x1b]4;bad;?\x07');

    assert.deepEqual(replies, [
      `\x1b]10;rgb:${rgb(theme.colors.fg)}\x1b\\`,
      `\x1b]11;rgb:${rgb(theme.colors.bg)}\x1b\\`,
    ]);
  } finally {
    screen.dispose();
  }
});

void test(
  'PTY children get truecolor even when the outer process disables colors',
  { timeout: 3000 },
  async () => {
    const originalNoColor = process.env['NO_COLOR'],
      originalForceColor = process.env['FORCE_COLOR'];
    let child: ReturnType<typeof spawnPty> | undefined;
    try {
      process.env['NO_COLOR'] = '1';
      process.env['FORCE_COLOR'] = '0';
      child = spawnPty(
        {
          id: 'color',
          name: 'Color',
          executable: process.execPath,
          args: [
            '-e',
            'console.log(JSON.stringify({ noColor: process.env.NO_COLOR ?? null, forceColor: process.env.FORCE_COLOR, term: process.env.TERM, colorterm: process.env.COLORTERM }));',
          ],
        },
        process.cwd(),
        80,
        24,
      );
    } finally {
      if (originalNoColor === undefined) {
        delete process.env['NO_COLOR'];
      } else {
        process.env['NO_COLOR'] = originalNoColor;
      }

      if (originalForceColor === undefined) {
        delete process.env['FORCE_COLOR'];
      } else {
        process.env['FORCE_COLOR'] = originalForceColor;
      }
    }

    const output = await new Promise<string>((resolve) => {
      let text = '';

      child.onData((data) => {
        text += data;
      });
      child.onExit(() => {
        resolve(text);
      });
    });

    assert.deepEqual(JSON.parse(output.trim()), {
      noColor: null,
      forceColor: '3',
      term: 'xterm-256color',
      colorterm: 'truecolor',
    });
  },
);

void test('history is bounded and scrolling hides the cursor', async () => {
  const screen = new XtermScreen(20, 4);

  try {
    await write(
      screen,
      Array.from({ length: 5020 }, (_, i) => `line${i}\r\n`).join(''),
    );
    screen.scroll(6000);

    assert.equal(screen.snapshot().scrollOffset, 5000);
    assert.equal(screen.snapshot().cursor.visible, false);
    assert.match(
      screen
        .snapshot(true)
        .lines.map((line) => line.map((cell) => cell.text).join(''))
        .join('\n'),
      /line5019/u,
    );
    assert.equal(screen.snapshot(true).scrollOffset, 0);

    screen.scrollToBottom();

    assert.equal(screen.snapshot().scrollOffset, 0);
  } finally {
    screen.dispose();
  }
});

void test('theme changes recolor existing terminal defaults and ANSI colors without losing output or RGB colors', async () => {
  const screen = new XtermScreen(20, 4);

  try {
    await write(
      screen,
      'plain\r\n\x1b[31mred\x1b[0m\r\n\x1b[38;2;12;34;56mRGB\x1b[0m\r\n\x1b[38;5;196mcube',
    );

    for (const theme of THEMES) {
      const snapshot = screen.snapshot(false, theme);

      assert.equal(
        defined(defined(snapshot.lines[0])[0]).style.fg,
        theme.colors.fg,
      );
      assert.equal(
        defined(defined(snapshot.lines[0])[0]).style.bg,
        theme.colors.bg,
      );
      assert.equal(
        defined(defined(snapshot.lines[1])[0]).style.fg,
        theme.ansi[1],
      );
      assert.equal(defined(defined(snapshot.lines[2])[0]).style.fg, 0x0c2238);
      assert.equal(defined(defined(snapshot.lines[3])[0]).style.fg, 0xff0000);
      assert.equal(
        defined(snapshot.lines[0])
          .slice(0, 5)
          .map((cell) => cell.text)
          .join(''),
        'plain',
      );
    }

    assert.equal(
      defined(defined(screen.snapshot().lines[0])[0]).style.bg,
      DEFAULT_THEME.colors.bg,
    );
  } finally {
    screen.dispose();
  }
});

void test(
  'agents launched manually inside real shells expose independent live activity and disappear on return to shell',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-awareness-'));
    const fixturePath = join(directory, 'codex.cjs');

    await writeFile(fixturePath, AGENT_FIXTURE);

    const mcPath = join(directory, 'mc.cjs');

    await writeFile(mcPath, "process.title = 'mc';\n" + AGENT_FIXTURE);

    const manager = new SessionManager(spawnPty, createScreen, () => {
      /* Test stub. */
    });
    const place = {
      id: 'p',
      name: 'Test',
      directory,
      agents: [],
      activeAgentId: null,
    };

    try {
      for (const id of ['a', 'b']) {
        manager.start({ id, name: 'Shell', profileId: 'shell' }, place, {
          id: 'shell',
          name: 'Shell',
          executable: '/bin/sh',
          args: ['-i'],
        });
        await manager.refreshActivity(id);

        assert.equal(defined(manager.sessions.get(id)).activity, null);

        manager.write(id, `'${process.execPath}' '${fixturePath}'\r`);
      }

      const a = defined(manager.sessions.get('a')),
        b = defined(manager.sessions.get('b'));

      await until(
        () =>
          text(a.screen).includes('FIXTURE_READY') &&
          a.activity === 'idle' &&
          b.activity === 'idle',
      );

      assert.equal(a.processName, 'codex');
      assert.equal(b.processName, 'codex');

      manager.write('a', 'n');
      manager.write('b', 'r');
      await until(
        () => a.threadName === 'Thread One' && b.threadName === 'Thread Two',
      );
      manager.write('a', 'w');
      manager.write('b', 'a');
      await until(() => a.activity === 'working' && b.activity === 'waiting');
      await delay(1700); // a quiet thinking agent must not become idle while its busy chrome remains

      assert.equal(a.activity, 'working');
      assert.equal(b.activity, 'waiting');
      assert.equal(a.threadName, 'Thread One');
      assert.equal(b.threadName, 'Thread Two');

      manager.write('b', 'i');
      await until(() => b.activity === 'idle');

      assert.equal(a.activity, 'working');

      manager.write('a', 'q');
      await until(() => a.activity === null);

      assert.equal(
        a.status,
        'running',
        'agent exit returns to the same live shell',
      );
      assert.equal(a.threadName, null);
      assert.equal(a.processName, 'sh');
      assert.equal(b.activity, 'idle');

      manager.write('a', "printf 'SHELL_%s\\n' BACK\r");
      await until(() => text(a.screen).includes('SHELL_BACK'));

      assert.equal(a.activity, null);

      manager.write('a', `'${process.execPath}' '${mcPath}'\r`);
      await until(() => a.processName === 'mc');

      assert.equal(a.activity, null);
      assert.equal(a.threadName, null);

      manager.write('a', 'q');
      await until(() => a.processName === 'sh');
    } finally {
      await manager.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'real PTYs run independently, take input, resize and terminate',
  { timeout: 10000 },
  async () => {
    const manager = new SessionManager(
      spawnPty,
      createScreen,
      () => {
        /* Test stub. */
      },
      undefined,
      100,
    );

    const fixture = `process.stdin.setRawMode(true); process.stdin.resume();
    process.stdout.write('READY '+process.argv[1]+'\\r\\n');
    process.stdin.on('data', d => process.stdout.write('INPUT:'+d.toString()+'\\r\\n'));
    process.stdout.on('resize', () => process.stdout.write('SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));
    setInterval(() => { /* Test stub. */ }, 1000);`;

    const place = {
      id: 'p',
      name: 'Test',
      directory: process.cwd(),
      agents: [],
      activeAgentId: null,
    };

    const a = { id: 'a', name: 'A', profileId: 'fixture' },
      b = { ...a, id: 'b', name: 'B' };

    try {
      manager.start(a, place, {
        id: 'fixture',
        name: 'Fixture',
        executable: process.execPath,
        args: ['-e', fixture, 'A'],
      });
      manager.start(b, place, {
        id: 'fixture',
        name: 'Fixture',
        executable: process.execPath,
        args: ['-e', fixture, 'B'],
      });
      await until(
        () =>
          text(defined(manager.sessions.get('a')).screen).includes('READY A') &&
          text(defined(manager.sessions.get('b')).screen).includes('READY B'),
      );
      manager.write('b', 'hello');
      await until(() =>
        text(defined(manager.sessions.get('b')).screen).includes('INPUT:hello'),
      );

      assert.ok(
        !text(defined(manager.sessions.get('a')).screen).includes(
          'INPUT:hello',
        ),
      );

      manager.resize(90, 20);
      await until(() =>
        ['a', 'b'].every((id) =>
          text(defined(manager.sessions.get(id)).screen).includes('SIZE:90x20'),
        ),
      );
      await manager.stop('a');

      assert.equal(defined(manager.sessions.get('a')).status, 'stopped');
      assert.equal(defined(manager.sessions.get('b')).status, 'running');
    } finally {
      await manager.shutdown();
    }
  },
);

void test(
  'real interactive shell cd is observed without injecting commands or changing shell config',
  { timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-cd-'));
    const project = join(directory, 'project with spaces');

    await mkdir(project);

    const manager = new SessionManager(
      spawnPty,
      createScreen,
      () => {
        /* Test stub. */
      },
      undefined,
      100,
    );

    const agent = {
      id: 'shell',
      name: 'Shell',
      profileId: 'shell',
      kind: 'shell' as const,
    };
    const place = {
      id: 'p',
      name: 'Test',
      directory,
      agents: [agent],
      activeAgentId: agent.id,
    };

    let observed = directory;

    manager.onDirectoryChange((id, cwd) => {
      assert.equal(id, agent.id);

      observed = cwd;
    });

    try {
      manager.start(agent, place, {
        id: 'shell',
        name: 'Shell',
        executable: 'sh',
        args: ['-i'],
      });

      const session = defined(manager.sessions.get(agent.id));

      assert.equal(session.status, 'running');

      const initial = await readProcessDirectory(defined(session.process).pid);

      assert.ok(initial?.endsWith(defined(directory.split('/').at(-1)))); // macOS /tmp is canonicalized

      manager.write(agent.id, `cd '${project}'\rprintf 'CWD_READY\\n'\r`);
      await until(() => text(session.screen).includes('CWD_READY'));
      await until(() => observed.endsWith('/project with spaces'));
      manager.write(agent.id, "printf 'INPUT_%s\\n' WORKS\r");
      await until(() => text(session.screen).includes('INPUT_WORKS'));
    } finally {
      await manager.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test('Unicode terminal cells match Rezi for emoji, flags, modifiers and combining text across writes', async () => {
  const screen = new XtermScreen(40, 4);

  try {
    for (const glyph of [
      '🦆',
      '😀',
      '👩‍💻',
      '❤️',
      '❤',
      '🇷🇺',
      'e\u0301',
      '1️⃣',
      '👍🏽',
      '界',
    ]) {
      await write(screen, '\x1bc');

      for (const codepoint of glyph) {
        await write(screen, codepoint);
      }

      await write(screen, 'X');

      const width = measureTextCells(glyph);
      const snapshot = screen.snapshot();

      assert.equal(snapshot.cursor.x, width + 1, glyph);
      assert.equal(snapshot.lines[0]?.[0]?.text, glyph);
      assert.equal(snapshot.lines[0][0].width, width);
      assert.equal(snapshot.lines[0][width]?.text, 'X');
      assert.equal(screen.textAt(width, 0)?.index, glyph.length);

      const selection = new TerminalSelection(snapshot, 40, 4, 0, 0);

      selection.move(width, 0);

      assert.equal(selection.text, glyph + 'X');
    }

    screen.resize(4, 4);
    await write(screen, '\x1bcabc🦆X');

    assert.equal(screen.snapshot().wrapped?.[1], true);
    assert.equal(screen.snapshot().lines[1]?.[0]?.text, '🦆');
    assert.equal(screen.snapshot().lines[1]?.[2]?.text, 'X');
  } finally {
    screen.dispose();
  }
});

void test('synchronized output holds the displayed frame and hit testing until the batch ends', async () => {
  const screen = new XtermScreen(20, 4);
  let refreshed = false;

  screen.onRefresh(() => {
    refreshed = true;
  });

  try {
    await write(screen, 'before');

    const before = screen.snapshot();

    await write(screen, '\x1b[?2026h\x1b[Hpartial');

    assert.deepEqual(screen.snapshot(), before);
    assert.ok(text(screen).startsWith('before'));
    assert.ok(screen.textAt(3, 0)?.text.startsWith('before'));
    assert.equal(screen.textAt(3, 0)?.index, 3);
    assert.equal(screen.snapshot(true).lines[0]?.[0]?.text, 'p');

    screen.scrollToBottom();
    await write(screen, '\x1b[?2026h');

    assert.deepEqual(
      screen.snapshot(),
      before,
      'repeated begin must not publish an intermediate frame',
    );

    await write(screen, '\x1b[Hcomplete\x1b[?2026l');

    assert.ok(text(screen).startsWith('complete'));
    assert.equal(refreshed, true);

    await write(
      screen,
      '\x1b[?2026h\x1b[Hnext\x1b[?2026l\x1b[?2026h\x1b[Hhidden',
    );

    assert.ok(text(screen).startsWith('next'));

    await write(screen, '\x1bc');

    assert.equal(text(screen).trim(), '');
  } finally {
    screen.dispose();
  }
});

void test('live text preserves Unicode and concealed cells independently of history and synchronized frames', async () => {
  const screen = new XtermScreen(20, 4);

  try {
    await write(screen, 'history\r\n'.repeat(8) + '\x1b[2J\x1b[H');
    await write(screen, '界👩‍💻e\u0301\x1b[8msecret\x1b[0mX');

    assert.equal(screen.text(), '界👩‍💻e\u0301      X\n\n\n');

    screen.scroll(5);

    assert.match(text(screen), /history/u);
    assert.equal(screen.text(), '界👩‍💻e\u0301      X\n\n\n');

    await write(screen, '\x1b[?2026h\x1b[2J\x1b[Hlive');

    assert.match(text(screen), /history/u);
    assert.equal(screen.text(), 'live\n\n\n');

    await write(screen, '\x1b[?2026l\x1b[?1049h\x1b[Halternate');

    assert.equal(screen.text(), 'alternate\n\n\n');

    screen.resize(24, 5);

    assert.equal(screen.text(), 'alternate\n\n\n\n');
  } finally {
    screen.dispose();
  }
});

void test('synchronized hit testing preserves wrapped paths across history and wide glyph padding', async () => {
  const screen = new XtermScreen(20, 4);

  try {
    const file = 'a'.repeat(19) + '界' + 'b'.repeat(100) + '.ts';

    await write(screen, file + '\r\nnext.txt');

    const positions = Array.from({ length: screen.rows }, (_, y) =>
      Array.from({ length: screen.cols }, (_, x) => screen.textAt(x, y)),
    );

    await write(screen, '\x1b[?2026h\x1b[2J\x1b[Hchanged');

    for (let y = 0; y < screen.rows; y++) {
      for (let x = 0; x < screen.cols; x++) {
        assert.deepEqual(screen.textAt(x, y), positions[y]?.[x]);
      }
    }

    assert.ok(fileCandidates(screen.textAt(2, 0)).includes(file));

    await write(screen, '\x1b[?2026l');

    assert.equal(screen.textAt(0, 0)?.text.trimEnd(), 'changed');
  } finally {
    screen.dispose();
  }
});

void test('an unfinished synchronized frame expires and resize or disposal releases its timer', async () => {
  const screen = new XtermScreen(20, 4);
  let refreshed = false;

  screen.onRefresh(() => {
    refreshed = true;
  });

  try {
    await write(screen, 'old\x1b[?2026h\x1b[Hnew');

    assert.ok(text(screen).startsWith('old'));

    await delay(XtermScreen.SYNCHRONIZED_OUTPUT_TIMEOUT_MS + 50);

    assert.ok(text(screen).startsWith('new'));
    assert.equal(
      refreshed,
      true,
      'timeout requests a frame without further PTY output',
    );

    refreshed = false;
    await write(screen, '\x1b[?2026hchanged');
    screen.resize(25, 5);

    assert.equal(screen.snapshot().lines.length, 5);
    assert.equal(screen.snapshot().lines[0]?.length, 25);
    assert.equal(refreshed, true);

    await write(screen, '\x1b[?2026h');
    screen.dispose();
    refreshed = false;
    await delay(XtermScreen.SYNCHRONIZED_OUTPUT_TIMEOUT_MS + 50);

    assert.equal(refreshed, false, 'closed screens do not request redraws');
  } finally {
    screen.dispose();
  }
});

void test('terminal renders Unicode correctly after prior Node buffer allocations', () => {
  const result = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    Buffer.allocUnsafe(128).fill(0);
    const { XtermScreen } = await import(${JSON.stringify(new URL('../src/terminal/XtermScreen.js', import.meta.url).href)});
    const screen = new XtermScreen(20, 4);
    screen.write('👩‍💻🦆X', () => {
      const snapshot = screen.snapshot();
      process.stdout.write(JSON.stringify({
        text: snapshot.lines[0].filter(cell => cell.width > 0).map(cell => cell.text).join('').trimEnd(),
        cursor: snapshot.cursor.x,
      }));
      screen.dispose();
    });
  `,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );

  assert.deepEqual(JSON.parse(result), { text: '👩‍💻🦆X', cursor: 5 });
});

void test(
  'large real PTY output drains completely and terminal input remains usable',
  { timeout: 15000 },
  async () => {
    const manager = new SessionManager(
      spawnPty,
      createScreen,
      () => {
        /* Test stub. */
      },
      signalGroup,
      100,
    );

    const agent = { id: 'flood', name: 'Flood', profileId: 'flood' };

    try {
      manager.start(
        agent,
        {
          id: 'p',
          name: 'p',
          directory: process.cwd(),
          agents: [],
          activeAgentId: null,
        },
        {
          id: 'flood',
          name: 'Flood',
          executable: process.execPath,
          args: [
            '-e',
            `
        process.stdin.setRawMode(true);process.stdin.resume();
        process.stdin.on('data',d=>{if(d.toString().includes('p'))process.stdout.write('\\r\\nINPUT_OK\\r\\n')});
        for(let i=0;i<512;i++)process.stdout.write('x'.repeat(8192));
        process.stdout.write('\\r\\nOUTPUT_COMPLETE\\r\\n');
      `,
          ],
        },
      );

      const session = defined(manager.sessions.get(agent.id));

      await until(
        () => text(session.screen).includes('OUTPUT_COMPLETE'),
        10000,
      );
      manager.write(agent.id, 'p');
      await until(() => text(session.screen).includes('INPUT_OK'));

      assert.equal(session.status, 'running');
    } finally {
      await manager.shutdown();
    }
  },
);
