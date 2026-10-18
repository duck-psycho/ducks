import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import headless from '@xterm/headless';
import pty from 'node-pty';
import { defined } from '../src/defined.js';
import { defaultConfig } from '../src/model.js';
import { getTheme } from '../src/themes.js';
import { SIDEBAR_WIDTH } from '../src/ui/layout.js';
import { AGENT_FIXTURE } from './helpers.js';
import type { Config } from '../src/model.js';

function startTui(
  configPath: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {},
) {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(
    new URL(source ? '../src/cli.ts' : '../src/cli.js', import.meta.url),
  );
  const terminal = new headless.Terminal({
    cols: 120,
    rows: 35,
    allowProposedApi: true,
  });
  terminal.loadAddon(new UnicodeGraphemesAddon());

  const clipboard: string[] = [];

  terminal.parser.registerOscHandler(52, (data) => {
    const encoded = data.slice(data.indexOf(';') + 1);

    clipboard.push(Buffer.from(encoded, 'base64').toString('utf8'));

    return true;
  });

  const child = pty.spawn(
    process.execPath,
    [
      ...(source ? ['--import', 'tsx'] : []),
      entry,
      '--config',
      configPath,
      ...args,
    ],
    {
      cols: 120,
      rows: 35,
      cwd: process.cwd(),
      name: 'xterm-256color',
      env: {
        ...process.env,
        SHELL: '/bin/sh',
        ENV: '',
        TERM: 'xterm-256color',
        ...env,
      },
    },
  );

  let exited = false,
    exitCode: number | undefined;
  let output = '';

  child.onData((data) => {
    output = (output + data).slice(-4000);
    terminal.write(data);
  });
  terminal.onData((data) => {
    if (!exited) {
      child.write(data);
    }
  });
  child.onExit((event) => {
    exited = true;
    exitCode = event.exitCode;
  });

  const screen = () =>
    Array.from(
      { length: terminal.rows },
      (_, y) =>
        terminal.buffer.active
          .getLine(terminal.buffer.active.baseY + y)
          ?.translateToString(true) ?? '',
    ).join('\n');

  const tabs = () => defined(screen().split('\n')[0]).slice(SIDEBAR_WIDTH + 1);

  const until = async (
    condition: () => boolean | Promise<boolean>,
    label: string,
  ) => {
    const deadline = Date.now() + 8000;
    while (!(await condition())) {
      if (exited || Date.now() > deadline) {
        throw new Error(`${label}: exit=${exitCode}\n${screen()}\n${output}`);
      }

      await delay(20);
    }
  };

  const background = (x: number, y: number) => {
    const cell = terminal.buffer.active
      .getLine(terminal.buffer.active.baseY + y)
      ?.getCell(x);

    return cell?.isInverse() ? cell.getFgColor() : cell?.getBgColor();
  };

  const foreground = (x: number, y: number) => {
    const cell = terminal.buffer.active
      .getLine(terminal.buffer.active.baseY + y)
      ?.getCell(x);

    return cell?.isInverse() ? cell.getBgColor() : cell?.getFgColor();
  };

  const underline = (x: number, y: number) =>
    Boolean(
      terminal.buffer.active
        .getLine(terminal.buffer.active.baseY + y)
        ?.getCell(x)
        ?.isUnderline(),
    );

  const resize = (cols: number, rows: number) => {
    terminal.resize(cols, rows);
    child.resize(cols, rows);
  };

  return {
    child,
    screen,
    tabs,
    background,
    foreground,
    underline,
    mouseTracking: () => terminal.modes.mouseTrackingMode,
    clipboard,
    until,
    resize,
    exitCode: () => exitCode,
    dispose: () => {
      if (!exited) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Process already exited. */
        }
      }

      terminal.dispose();
    },
  };
}

void test(
  'native search opens a Place and finds a background agent by its sidebar thread name',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-search-'));
    const configPath = join(directory, 'config.json');
    const fixture = join(directory, 'codex.cjs');
    const config = defaultConfig();
    config.places = [
      {
        id: 'p',
        name: 'First',
        directory,
        agents: [{ id: 'a', name: 'Shell', profileId: 'codex' }],
        activeAgentId: 'a',
      },
      {
        id: 'q',
        name: 'Второй 🦆',
        directory,
        agents: [{ id: 'c', name: 'Shell', profileId: 'codex' }],
        activeAgentId: 'c',
      },
    ];
    config.activePlaceId = 'p';
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(fixture, AGENT_FIXTURE);

    const { child, screen, until, resize, dispose } = startTui(configPath);

    const searchOpen = () => screen().includes('Enter · Open');

    const shellReady = () =>
      screen()
        .split('\n')
        .some((line) => /[$#]\s*$/u.test(line));

    const find = async (query: string) => {
      child.write('\x02f');
      await until(searchOpen, 'search modal opens');
      child.write(query);
      await until(() => screen().includes(query), 'query renders');
      child.write('\r');
      await until(() => !searchOpen(), 'Enter opens the result');
    };

    try {
      await until(shellReady, 'startup shell');
      resize(80, 24);
      await find('ВТОРОЙ');
      child.write("printf 'SEARCH_%s\\n' PLACE\r");
      await until(
        () => screen().includes('SEARCH_PLACE'),
        'Place terminal takes input',
      );

      const saved = JSON.parse(await readFile(configPath, 'utf8')) as Config;

      assert.equal(saved.activePlaceId, 'q');
      assert.equal(saved.places[1]?.activeAgentId, 'c');

      child.write(`'${process.execPath}' '${fixture}'\r`);
      await until(() => screen().includes('FIXTURE_READY'), 'agent starts');
      child.write('n');
      await until(() => screen().includes('Thread One'), 'sidebar thread name');
      await find('First');
      await until(shellReady, 'original Place restored');
      await find('thread one');
      child.write('r');
      await until(
        () => screen().includes('Thread Two'),
        'matched agent takes input',
      );
      child.write('\x02q');
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI opens Commands shortcut help with Ctrl+B then ? and closes it at 80 × 24',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-help-'));
    const { child, screen, until, resize, dispose } = startTui(
      join(directory, 'config.json'),
    );

    try {
      await until(
        () => screen().includes('Ctrl+B ?'),
        'help hint at startup without Places',
      );
      resize(80, 24);
      child.write('\x02?');
      await until(
        () =>
          screen().includes('Keyboard shortcuts') &&
          screen().includes('Send literal Ctrl+B'),
        'all commands fit in shortcut help',
      );

      assert.match(screen(), /New Place with a shell/u);
      assert.match(screen(), /Commands · Ctrl\+B/u);
      assert.doesNotMatch(
        screen(),
        /no prefix|Shift\+PgUp|\$EDITOR|Preview next|PgUp\/PgDn/u,
      );

      child.write('\r');
      await until(
        () => !screen().includes('Keyboard shortcuts'),
        'Enter closes help',
      );
      child.write('\x02?');
      await until(
        () => screen().includes('Keyboard shortcuts'),
        'reopening help',
      );
      child.write('\x1b');
      await until(
        () => !screen().includes('Keyboard shortcuts'),
        'Escape closes help',
      );
      child.write('\x02q');
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI composes a multiline prompt, restores its draft and sends one bracketed paste followed by Enter',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-prompt-'));
    const fixture = join(directory, 'prompt.cjs');

    await writeFile(
      fixture,
      `process.stdin.setRawMode(true); process.stdin.resume();
    process.stdout.write('\\x1b[?2004hPROMPT_READY');
    let received = '';
    process.stdin.on('data', data => {
      received += data.toString();
      if (received.endsWith('\\r')) process.stdout.write('\\r\\nRECEIVED:' + Buffer.from(received).toString('hex'));
    });`,
    );

    const { child, screen, until, resize, dispose } = startTui(
      join(directory, 'config.json'),
      ['--place', directory],
    );

    try {
      child.write(`'${process.execPath}' '${fixture}'\r`);
      await until(
        () => screen().includes('PROMPT_READY'),
        'prompt receiver ready',
      );
      resize(80, 24);
      child.write('\x02p');
      await until(
        () => screen().includes('Ctrl/Alt+Enter · Send'),
        'prompt modal opens',
      );
      child.write('first line\rвторая 🦆');
      await until(
        () => screen().includes('first line') && screen().includes('вторая 🦆'),
        'multiline draft renders',
      );
      child.write('\x1b');
      await until(
        () => !screen().includes('Ctrl/Alt+Enter · Send'),
        'Escape keeps draft',
      );

      assert.doesNotMatch(screen(), /RECEIVED:/u);

      child.write('\x02p');
      await until(() => screen().includes('вторая 🦆'), 'draft restored');
      child.write('\x1b[13;5u');

      const expected = Buffer.from(
        '\x1b[200~first line\nвторая 🦆\x1b[201~\r',
      ).toString('hex');

      await until(
        () =>
          screen()
            .split('\n')
            .map((line) => line.slice(SIDEBAR_WIDTH + 1))
            .join('')
            .replace(/\s/gu, '')
            .includes(`RECEIVED:${expected}`),
        'Ctrl+Enter delivers exactly one multiline paste and submission',
      );

      assert.ok(!screen().includes('Ctrl/Alt+Enter · Send'));

      child.write('\x02q');
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI forwards legacy and enhanced Alt word-editing chords to readline',
  { timeout: 15000 },
  async (t) => {
    let bash: string | undefined;
    for (const directory of (process.env['PATH'] ?? '/bin:/usr/bin').split(
      ':',
    )) {
      const candidate = join(directory, 'bash');

      try {
        await access(candidate);
        bash = candidate;
        break;
      } catch {
        /* Try the next PATH entry. */
      }
    }

    if (!bash) {
      t.skip('readline integration requires bash');

      return;
    }

    const directory = await mkdtemp(join(tmpdir(), 'ducks-alt-'));
    const { child, screen, tabs, until, dispose } = startTui(
      join(directory, 'config.json'),
      ['--place', directory],
      { INPUTRC: '/dev/null' },
    );

    try {
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'source shell',
      );
      child.write(`'${bash}' --noprofile --norc -i\r`);
      await until(() => /\bbash\b/u.test(tabs()), 'readline shell');
      child.write("printf 'ALT_BACKSPACE_RESULT:%s\\n' alpha beta");
      await until(() => screen().includes('alpha beta'), 'word-editing input');
      child.write('\x1b\x7f\r');
      await until(
        () => /ALT_BACKSPACE_RESULT:alpha\s*$/mu.test(screen()),
        'legacy Alt+Backspace deletes the last word',
      );

      assert.doesNotMatch(screen(), /ALT_BACKSPACE_RESULT:beta/u);

      child.write("printf 'ALT_MOVE_RESULT:%s\\n' one two");
      await until(() => screen().includes('one two'), 'word-navigation input');
      child.write('\x1bb\x1bd\r');
      await until(
        () => /ALT_MOVE_RESULT:one\s*$/mu.test(screen()),
        'Alt+B moves back and Alt+D deletes a word',
      );

      assert.doesNotMatch(screen(), /ALT_MOVE_RESULT:two/u);

      child.write("printf 'ALT_ENHANCED_RESULT:%s\\n' first second");
      await until(
        () => screen().includes('first second'),
        'enhanced keyboard input',
      );
      child.write('\x1b[127;3u\r');
      await until(
        () => /ALT_ENHANCED_RESULT:first\s*$/mu.test(screen()),
        'CSI-u Alt+Backspace deletes a word',
      );

      assert.doesNotMatch(screen(), /ALT_ENHANCED_RESULT:second/u);

      child.write('exit\r\x02q');
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'working squares pulse without new PTY output and settle into steady idle and waiting squares',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-spinner-'));
    const fixturePath = join(directory, 'codex.cjs');

    await writeFile(fixturePath, AGENT_FIXTURE);

    const { child, screen, tabs, foreground, until, dispose } = startTui(
      join(directory, 'config.json'),
      ['--place', directory],
    );
    const colors = getTheme('catppuccin-mocha').colors;

    const indicator = () => tabs().trimStart()[0];

    const sidebarIndicator = () => screen().split('\n')[2]?.[2];

    const terminalText = () =>
      screen()
        .split('\n')
        .slice(1, -2)
        .map((line) => line.slice(SIDEBAR_WIDTH + 1))
        .join('\n');

    try {
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'source shell',
      );
      child.write(`'${process.execPath}' '${fixturePath}'\r`);
      await until(
        () =>
          tabs().includes('■ codex') &&
          foreground(SIDEBAR_WIDTH + 2, 0) === colors.green,
        'idle agent',
      );
      child.write('w');
      await until(
        () =>
          indicator() === '■' &&
          foreground(SIDEBAR_WIDTH + 2, 0) !== colors.green &&
          foreground(SIDEBAR_WIDTH + 2, 0) !== colors.red,
        'working square',
      );

      const first = foreground(SIDEBAR_WIDTH + 2, 0);
      const output = terminalText();

      await until(
        () => foreground(SIDEBAR_WIDTH + 2, 0) !== first,
        'square brightness changes while agent is silent',
      );

      assert.equal(indicator(), '■', 'animation never changes the glyph');
      assert.equal(
        terminalText(),
        output,
        'animation does not change terminal content',
      );
      assert.equal(
        sidebarIndicator(),
        indicator(),
        'sidebar and tab use the same square',
      );
      assert.equal(
        foreground(2, 2),
        foreground(SIDEBAR_WIDTH + 2, 0),
        'sidebar and tab pulse together',
      );

      child.write('i');
      await until(
        () =>
          indicator() === '■' &&
          foreground(SIDEBAR_WIDTH + 2, 0) === colors.green &&
          sidebarIndicator() === '■' &&
          foreground(2, 2) === colors.green,
        'idle stops animation',
      );
      await delay(250);

      assert.equal(indicator(), '■');
      assert.equal(foreground(SIDEBAR_WIDTH + 2, 0), colors.green);
      assert.equal(sidebarIndicator(), '■');
      assert.equal(foreground(2, 2), colors.green);

      child.write('a');
      await until(
        () =>
          indicator() === '■' &&
          foreground(SIDEBAR_WIDTH + 2, 0) === colors.red &&
          sidebarIndicator() === '■' &&
          foreground(2, 2) === colors.red,
        'approval remains a red square',
      );
      child.write('q');
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'return to shell',
      );
      child.write('\x02q');
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI preserves wheel direction for mouse-aware programs and terminal history',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-wheel-'));
    const configPath = join(directory, 'config.json');
    const fixturePath = join(directory, 'wheel.cjs');

    await writeFile(
      fixturePath,
      `process.stdin.setRawMode(true); process.stdin.resume();
    const paint = text => process.stdout.write('\\x1b[2J\\x1b[H' + text);
    let input = '';
    process.stdin.on('data', data => {
      if (data.toString() === 'h') {
        process.stdout.write('\\x1b[?1000l\\x1b[?1006l');
        paint(Array.from({ length: 80 }, (_, i) => 'history line ' + i).join('\\r\\n') + '\\r\\nHISTORY_READY');
        return;
      }
      input += data.toString();
      input = input.replace(/\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])/g, (_, button) => {
        if (Number(button) === 65) paint('MOUSE_DOWN');
        if (Number(button) === 64) paint('MOUSE_UP');
        return '';
      });
    });
    process.stdout.write('\\x1b[?1000h\\x1b[?1006h'); paint('WHEEL_READY');`,
    );

    const { child, screen, tabs, until, dispose } = startTui(configPath);

    const wheel = (button: 64 | 65) => {
      child.write(`\x1b[<${button};${SIDEBAR_WIDTH + 3};3M`);
    };

    try {
      await until(() => screen().includes('Ctrl+B'), 'startup');
      child.write('\x02s');
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'shell',
      );
      child.write(`'${process.execPath}' '${fixturePath}'\r`);
      await until(
        () => screen().includes('WHEEL_READY'),
        'mouse-aware program',
      );
      wheel(65);
      await until(
        () => screen().includes('MOUSE_DOWN'),
        'wheel down reaches the program as down',
      );
      wheel(64);
      await until(
        () => screen().includes('MOUSE_UP'),
        'wheel up reaches the program as up',
      );
      child.write('h');
      await until(
        () => screen().includes('HISTORY_READY'),
        'terminal history without mouse tracking',
      );
      wheel(64);
      await until(
        () => screen().includes('History: 3 lines up'),
        'wheel up enters history',
      );
      wheel(65);
      await until(
        () =>
          !screen().includes('History:') && screen().includes('HISTORY_READY'),
        'wheel down returns to live output',
      );
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'Ctrl+hover highlights a clickable file and Ctrl+click opens its editor PTY',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-click-'));
    const project = join(directory, 'project');

    await mkdir(project);

    const file = join(project, 'click-target.txt');

    await writeFile(file, 'text file\n');

    const editor = join(directory, 'editor fixture.cjs');

    await writeFile(
      editor,
      `process.stdin.setRawMode(true); process.stdin.resume();
    process.stdout.write('\\x1b[2J\\x1b[HEDITOR_READY ' + JSON.stringify(process.argv.slice(2)));
    process.stdin.on('data', data => { if (data.toString().includes('q')) process.exit(0); });`,
    );

    const configPath = join(directory, 'config.json');
    const {
      child,
      screen,
      tabs,
      foreground,
      underline,
      mouseTracking,
      until,
      dispose,
    } = startTui(configPath, ['--place', directory], {
      EDITOR: `'${process.execPath}' '${editor}' --flag 'two words'`,
    });

    try {
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'source shell',
      );

      assert.equal(
        mouseTracking(),
        'any',
        'the outer terminal must report motion without pressed buttons',
      );

      child.write(`cd '${project}'\r`);
      child.write("printf '\\033[2J\\033[H%s\\r\\n' 'click-target.txt:12:3'\r");
      await until(
        () =>
          screen()
            .split('\n')[1]
            ?.slice(SIDEBAR_WIDTH + 1)
            .startsWith('click-target.txt:12:3') === true,
        'printed file link',
      );

      const colors = getTheme('catppuccin-mocha').colors;

      const move = (button: number, x = SIDEBAR_WIDTH + 5, y = 2) => {
        child.write(`\x1b[<${button};${x};${y}M`);
      };

      move(51); // Ctrl + motion with no pressed mouse buttons.
      await until(
        () => underline(SIDEBAR_WIDTH + 1, 1),
        'Ctrl+hover underlines the file',
      );

      assert.equal(foreground(SIDEBAR_WIDTH + 1, 1), colors.accent);

      for (let x = 0; x < 'click-target.txt:12:3'.length; x++) {
        assert.ok(
          underline(SIDEBAR_WIDTH + 1 + x, 1),
          'the complete clickable range is highlighted',
        );
      }

      assert.equal(
        underline(SIDEBAR_WIDTH + 22, 1),
        false,
        'spaces beside the link keep their style',
      );

      move(35);
      await until(
        () => !underline(SIDEBAR_WIDTH + 1, 1),
        'moving without Ctrl clears the highlight',
      );
      move(51);
      await until(() => underline(SIDEBAR_WIDTH + 1, 1), 'hover again');
      move(51, 2, 3);
      await until(
        () => !underline(SIDEBAR_WIDTH + 1, 1),
        'leaving the terminal clears the highlight',
      );
      move(51);
      await until(
        () => underline(SIDEBAR_WIDTH + 1, 1),
        'hover before opening',
      );
      child.write(`\x1b[<16;${SIDEBAR_WIDTH + 5};2M`);
      await until(
        () => screen().includes('EDITOR_READY'),
        'editor launched by Ctrl+click',
      );

      const terminalText = screen()
        .split('\n')
        .slice(1, -2)
        .map((line) => line.slice(SIDEBAR_WIDTH + 1, -1).trimEnd())
        .join('');

      assert.ok(
        terminalText.includes(file),
        'relative link resolves from the source process cwd',
      );
      assert.match(screen(), /--flag.*two words/u);
      assert.ok(
        /\bsh\b/u.test(tabs()),
        'the source shell keeps running in its tab',
      );

      child.write(`\x1b[<0;${SIDEBAR_WIDTH + 5};2m`); // Release after focus changed, without Ctrl.
      child.write('q');
      await until(
        () => !screen().includes('EDITOR_READY') && /\bsh\b/u.test(tabs()),
        'editor tab closes',
      );
      child.write("printf 'SOURCE_STILL_ALIVE\\n'\r");
      await until(
        () => screen().includes('SOURCE_STILL_ALIVE'),
        'source shell accepts input',
      );
      child.write('\x02q');
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'Ctrl+click nano editor scrolls its file with the wheel without changing the file',
  { timeout: 15000 },
  async (t) => {
    let nano: string | undefined;
    for (const directory of (process.env['PATH'] ?? '/bin:/usr/bin').split(
      ':',
    )) {
      const candidate = join(directory, 'nano');

      try {
        await access(candidate);
        nano = candidate;
        break;
      } catch {
        /* Try the next PATH entry. */
      }
    }

    if (!nano) {
      t.skip('editor integration requires nano');

      return;
    }

    const directory = await mkdtemp(join(tmpdir(), 'ducks-nano-wheel-'));
    const file = join(directory, 'wheel.txt');
    const content =
      Array.from(
        { length: 120 },
        (_, i) => `WHEEL_LINE_${String(i + 1).padStart(3, '0')}`,
      ).join('\n') + '\n';

    await writeFile(file, content);

    const { child, screen, tabs, until, dispose } = startTui(
      join(directory, 'config.json'),
      ['--place', directory],
      {
        EDITOR: `'${nano}' --ignorercfiles`,
      },
    );

    const wheel = (button: 64 | 65) => {
      child.write(`\x1b[<${button};${SIDEBAR_WIDTH + 5};4M`);
    };

    try {
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'source shell',
      );
      child.write("printf '\\033[2J\\033[H%s\\r\\n' 'wheel.txt'\r");
      await until(
        () =>
          screen()
            .split('\n')[1]
            ?.slice(SIDEBAR_WIDTH + 1)
            .startsWith('wheel.txt') === true,
        'printed file link',
      );
      child.write(`\x1b[<16;${SIDEBAR_WIDTH + 5};2M`);
      await until(
        () => screen().includes('WHEEL_LINE_001'),
        'nano opened by Ctrl+click',
      );
      child.write(`\x1b[<0;${SIDEBAR_WIDTH + 5};2m`);

      for (let i = 0; i < 12; i++) {
        wheel(65);
      }

      await until(
        () =>
          !screen().includes('WHEEL_LINE_001') &&
          screen().includes('WHEEL_LINE_037'),
        'wheel down scrolls the file past its first line',
      );

      assert.ok(
        !screen().includes('History:'),
        'nano navigation does not scroll terminal history',
      );

      for (let i = 0; i < 12; i++) {
        wheel(64);
      }

      await until(
        () => screen().includes('WHEEL_LINE_001'),
        'wheel up returns to the start of the file',
      );
      child.write('\x18');
      await until(
        () => !tabs().includes('wheel.txt') && /\bsh\b/u.test(tabs()),
        'nano exits without a save prompt',
      );

      assert.equal(await readFile(file, 'utf8'), content);

      child.write('\x02q');
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI keeps the shortcut bar on the bottom row after resizing',
  { timeout: 20000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-resize-'));
    const configPath = join(directory, 'config.json');
    const { child, screen, background, until, resize, dispose } =
      startTui(configPath);
    const footerColor = getTheme('catppuccin-mocha').colors.sidebar;

    try {
      await until(() => screen().includes('Ctrl+B'), 'startup');
      child.write('\x02s');
      await until(
        () => /\bsh\b/u.test(defined(screen().split('\n')[0])),
        'shell',
      );

      // A quick shrink/grow can return to the same size between backend polls.
      // The idle shell supplies no output that could accidentally repair it.
      for (const [cols, rows] of [
        [120, 34],
        [119, 35],
        [120, 33],
        [118, 34],
      ] as const) {
        resize(cols, rows);
        resize(120, 35);
        await delay(300);

        assert.match(
          defined(screen().split('\n').at(-1)),
          /Ctrl\+B/u,
          'footer survives a resize burst ending at the original dimensions',
        );
        assert.equal(background(0, 34), footerColor);
        assert.equal(background(119, 34), footerColor);
      }

      child.write("while :; do printf 'resize output\\n'; sleep 0.01; done\r");
      await until(
        () => screen().includes('resize output'),
        'continuous output',
      );

      for (const [cols, rows] of [
        [100, 30],
        [101, 31],
        [120, 35],
        [80, 24],
        [120, 40],
        [90, 25],
        [121, 36],
      ] as const) {
        resize(cols, rows);
        await until(
          () => screen().split('\n').at(-1)?.includes('Ctrl+B') === true,
          `footer after resize to ${cols} × ${rows}`,
        );

        assert.equal(background(0, rows - 1), footerColor);
        assert.equal(background(cols - 1, rows - 1), footerColor);
      }

      for (let i = 0; i < 100; i++) {
        resize(80 + (i % 41), 24 + (i % 17));
        await delay(3);
      }

      resize(120, 35);
      // Let the resize debounce and any frames already in flight settle before
      // checking that subsequent terminal output leaves the repaired bar intact.
      await delay(300);
      await until(
        () => screen().split('\n').at(-1)?.includes('Ctrl+B') === true,
        'footer after rapid resizes',
      );
      await delay(200);

      assert.match(defined(screen().split('\n').at(-1)), /Ctrl\+B/u);
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI reports its palette and preserves RGB animation frames with unchanged text',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-colors-'));
    const fixturePath = join(directory, 'animation.cjs');

    await writeFile(
      fixturePath,
      `process.stdin.setRawMode(true); process.stdin.resume();
    const paint = (color) => process.stdout.write('\\x1b[2J\\x1b[H\\x1b[38;2;' + color + 'mWorking\\x1b[0m');
    let input = '', ready = false;
    process.stdin.on('data', data => {
      input += data.toString();
      if (!ready && input.includes('10;rgb:2424/2929/2f2f') && input.includes('11;rgb:ffff/ffff/ffff')) {
        ready = true;
        paint(process.env.NO_COLOR === undefined && process.env.FORCE_COLOR === '3' ? '80;90;100' : '128;128;128');
      } else if (ready && data.toString().includes('b')) paint('180;190;200');
    });
    process.stdout.write('\\x1b]10;?\\x07\\x1b]11;?\\x1b\\\\');`,
    );

    const configPath = join(directory, 'config.json');
    const config = defaultConfig();
    config.theme = 'github-light';
    await writeFile(configPath, JSON.stringify(config));

    const { child, tabs, screen, foreground, until, dispose } =
      startTui(configPath);

    try {
      await until(() => screen().includes('Ctrl+B'), 'startup');
      child.write('\x02s');
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'shell',
      );
      child.write(`'${process.execPath}' '${fixturePath}'\r`);
      await until(
        () =>
          screen().includes('Working') &&
          foreground(SIDEBAR_WIDTH + 1, 1) === 0x505a64,
        'palette replies and initial RGB frame',
      );
      child.write('b');
      await until(
        () => foreground(SIDEBAR_WIDTH + 1, 1) === 0xb4bec8,
        'color-only animation frame',
      );
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI closes Places and their tabs, persists the removal and preserves project files',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-close-place-'));
    const configPath = join(directory, 'config.json');
    const projectFile = join(directory, 'keep.txt');

    await writeFile(projectFile, 'project contents');

    const config = defaultConfig();
    config.profiles.push({
      id: 'shell',
      name: 'Shell',
      executable: '/bin/sh',
      args: ['-i'],
    });
    config.places.push({
      id: 'p',
      name: 'Closable',
      directory,
      agents: [
        { id: 'a', name: 'Shell', profileId: 'shell', kind: 'shell' },
        { id: 'b', name: 'Shell 2', profileId: 'shell' },
      ],
      activeAgentId: 'a',
    });
    config.places.push({
      id: 'q',
      name: 'Survivor',
      directory,
      agents: [{ id: 'c', name: 'Shell', profileId: 'shell', kind: 'shell' }],
      activeAgentId: 'c',
    });
    config.activePlaceId = 'p';
    await writeFile(configPath, JSON.stringify(config));

    const { child, screen, tabs, until, dispose, exitCode } =
      startTui(configPath);

    const saved = async () =>
      JSON.parse(await readFile(configPath, 'utf8')) as Config;

    try {
      await until(
        () =>
          (tabs().match(/\bsh\b/gu)?.length ?? 0) === 2 &&
          hasShellPrompt(screen()),
        'saved Place starts both terminals',
      );
      child.write('\x02x');
      await until(
        () => screen().includes('Close this Place and all its terminals?'),
        'Place close confirmation',
      );
      child.write('\x1b[B\r'); // Select Cancel explicitly.
      await until(
        () => !screen().includes('Close this Place and all its terminals?'),
        'cancel close',
      );

      assert.equal((await saved()).places.length, 2);

      child.write('\x02x');
      await until(
        () => screen().includes('Close this Place and all its terminals?'),
        'confirm close again',
      );
      child.write('\r');
      await until(async () => {
        const config = await saved();

        return (
          config.places.length === 1 &&
          config.activePlaceId === 'q' &&
          !screen().includes('Closable')
        );
      }, 'closed Place is removed from screen and configuration');
      child.write("printf 'SURVIVING_%s\\n' PLACE\r");
      await until(
        () => screen().includes('SURVIVING_PLACE'),
        'neighbouring Place stays interactive',
      );

      assert.equal(await readFile(projectFile, 'utf8'), 'project contents');

      child.write('\x02x');
      await until(
        () => screen().includes('Close this Place and all its terminals?'),
        'close last Place',
      );
      child.write('\r');
      await until(async () => {
        const config = await saved();

        return (
          config.places.length === 0 &&
          config.activePlaceId === null &&
          screen().includes('Open your first Place')
        );
      }, 'last Place removal leaves an empty usable TUI');
      child.write('\x02s');
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'new Place opens after closing all Places',
      );
      child.write('\x02q');
      await until(() => exitCode() !== undefined, 'orderly exit');

      assert.equal(exitCode(), 0);
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI opens terminals, closes tabs on shell exit and keeps an empty Place usable',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-tui-'));
    const project = join(directory, 'my-project');

    await mkdir(project);
    await new Promise<void>((resolve, reject) =>
      execFile(
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- Resolve the user's installed Git; arguments are passed separately.
        'git',
        ['-C', project, 'init', '--initial-branch=main', '--template='],
        (error) => {
          if (error) {
            reject(new Error('Git command failed', { cause: error }));
          } else {
            resolve();
          }
        },
      ),
    );

    const configPath = join(directory, 'config.json');
    const fixturePath = join(directory, 'codex.cjs');

    await writeFile(fixturePath, AGENT_FIXTURE);

    const mcPath = join(directory, 'mc.cjs');

    await writeFile(mcPath, "process.title = 'mc';\n" + AGENT_FIXTURE);

    const {
      child,
      screen,
      tabs,
      background,
      foreground,
      until,
      dispose,
      exitCode,
    } = startTui(configPath);

    const indicatorColor = () => foreground(SIDEBAR_WIDTH + 2, 0);

    try {
      await until(() => screen().includes('Ctrl+B'), 'TUI startup');
      child.write('\x02s');
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'new shell Place',
      );

      assert.doesNotMatch(screen(), /Running|Starting|Stopped|■/u);

      child.write(`cd '${project}'\rprintf 'SMOKE_%s\\n' 'OK'\r`);
      await until(() => screen().includes('SMOKE_OK'), 'typed command output');
      child.write(`'${process.execPath}' '${fixturePath}'\r`);

      const sidebar = () =>
        screen()
          .split('\n')
          .map((line) => line.slice(0, SIDEBAR_WIDTH))
          .join('\n');

      await until(
        () =>
          screen().includes('FIXTURE_READY') &&
          tabs().includes('codex') &&
          indicatorColor() === getTheme('catppuccin-mocha').colors.green &&
          sidebar().includes('codex'),
        'unnamed agent uses its active process name and colored indicator in sidebar and tab',
      );
      child.write('n');
      await until(
        () => sidebar().includes('Thread One'),
        'thread name replaces Shell in sidebar',
      );

      assert.match(
        tabs(),
        /■ codex/u,
        'tab uses the active process and agent indicator',
      );
      assert.doesNotMatch(tabs(), /Working|Idle|Waiting for input/u);
      assert.doesNotMatch(
        tabs(),
        /Thread One/u,
        'thread name appears only in the sidebar',
      );

      child.write('\x02m');
      await until(
        () =>
          screen().includes('Settings') &&
          screen().includes('Catppuccin Mocha · Dark'),
        'settings modal opens',
      );
      child.write('\x1b[C\x1b[C\x1b[C');
      await until(
        () =>
          screen().includes('Catppuccin Latte · Light') &&
          background(0, 0) === getTheme('catppuccin-latte').colors.sidebar,
        'arrow keys immediately preview the light theme',
      );

      assert.equal(
        (JSON.parse(await readFile(configPath, 'utf8')) as Config).theme,
        'catppuccin-mocha',
      );

      child.write('\x1b');
      await until(
        () =>
          !screen().includes('Settings') &&
          background(0, 0) === getTheme('catppuccin-mocha').colors.sidebar,
        'cancel restores the original theme',
      );
      child.write('\x02m');
      await until(() => screen().includes('Settings'), 'reopen settings');
      child.write('\x1b[C\x1b[C\x1b[C\r');
      await until(async () => {
        const saved = JSON.parse(await readFile(configPath, 'utf8')) as Config;

        return (
          saved.theme === 'catppuccin-latte' && !screen().includes('Settings')
        );
      }, 'light theme applied and persisted');

      assert.equal(
        background(0, 0),
        getTheme('catppuccin-latte').colors.sidebar,
      );
      assert.ok(
        sidebar().includes('Thread One'),
        'saving settings preserves the agent',
      );
      assert.equal(
        background(SIDEBAR_WIDTH + 1, 2),
        getTheme('catppuccin-latte').colors.bg,
      );

      child.write('w');
      await until(
        () =>
          tabs().includes('■ codex') &&
          indicatorColor() !== getTheme('catppuccin-latte').colors.green &&
          indicatorColor() !== getTheme('catppuccin-latte').colors.red,
        'agent working tab indicator',
      );
      child.write('a');
      await until(
        () => indicatorColor() === getTheme('catppuccin-latte').colors.red,
        'agent approval tab indicator',
      );

      assert.ok(
        sidebar().includes('Thread One'),
        'working and approval markers are stripped from the thread name',
      );

      child.write('i');
      await until(
        () => indicatorColor() === getTheme('catppuccin-latte').colors.green,
        'agent ready again',
      );
      child.write('r');
      await until(
        () => sidebar().includes('Thread Two'),
        'thread rename updates sidebar live',
      );

      assert.match(tabs(), /■ codex/u);
      assert.doesNotMatch(
        tabs(),
        /Thread One|Thread Two|Working|Idle|Waiting for input/u,
      );

      child.write('q');
      await until(
        () => !tabs().includes('■'),
        'return to shell clears agent indicator',
      );
      await until(
        () =>
          !sidebar().includes('Thread Two') &&
          /› sh\s*$/mu.test(sidebar()) &&
          /\bsh\b/u.test(tabs()),
        'return to shell restores its process name in sidebar and tab',
      );
      child.write(`'${process.execPath}' '${mcPath}'\r`);
      await until(
        () => /› mc\s*$/mu.test(sidebar()) && /\bmc\b/u.test(tabs()),
        'ordinary foreground process name is displayed in sidebar and tab',
      );

      assert.ok(
        !tabs().includes('■'),
        'ordinary programs do not get agent indicators',
      );

      child.write('q');
      await until(
        () => /› sh\s*$/mu.test(sidebar()),
        'ordinary program exit restores shell process name',
      );
      await until(async () => {
        try {
          const config = JSON.parse(
            await readFile(configPath, 'utf8'),
          ) as Config;

          // macOS resolves /tmp to /private/tmp.
          return Boolean(
            config.places[0]?.directory.endsWith(
              project.slice(project.indexOf('/ducks-tui-')),
            ),
          );
        } catch {
          return false;
        }
      }, 'persisted directory');
      await until(
        () => /\bmain\s*$/mu.test(sidebar()),
        'Git branch in Place sidebar',
      );

      assert.ok(!screen().includes('PLACES'));

      child.write('git switch -c topic\r');
      await until(
        () => /\btopic\s*$/mu.test(sidebar()),
        'Git branch refresh after switch',
      );
      child.write('\x02a');
      await until(
        () => (tabs().match(/\bsh\b/gu)?.length ?? 0) === 2,
        'new terminal without dialogs',
      );
      child.write('printf \'TAB_%s:%s\\n\' READY "$PWD"\r');
      await until(
        () =>
          screen().includes('TAB_READY:') && screen().includes('/my-project'),
        'new terminal input and inherited cwd',
      );

      const config = JSON.parse(await readFile(configPath, 'utf8')) as Config;

      assert.equal(config.places[0]?.agents.length, 2);
      assert.equal(config.places[0].agents[1]?.profileId, 'shell');

      child.write('exit\r');
      await until(async () => {
        const saved = JSON.parse(await readFile(configPath, 'utf8')) as Config;

        return (
          saved.places[0]?.agents.length === 1 &&
          (tabs().match(/\bsh\b/gu)?.length ?? 0) === 1
        );
      }, 'exit closes active tab and selects remaining shell');
      child.write("printf 'SURVIVING_%s\\n' TAB\r");
      await until(
        () => screen().includes('SURVIVING_TAB'),
        'input reaches the neighbouring tab',
      );
      child.write('exit\r');
      await until(async () => {
        const saved = JSON.parse(await readFile(configPath, 'utf8')) as Config;

        return (
          saved.places[0]?.agents.length === 0 &&
          screen().includes('No terminals in this Place')
        );
      }, 'last shell exit closes its tab');

      const empty = JSON.parse(await readFile(configPath, 'utf8')) as Config;

      assert.equal(empty.places.length, 1);
      assert.equal(empty.places[0]?.agents.length, 0);
      assert.equal(empty.places[0].activeAgentId, null);

      child.write('\x02a');
      await until(
        () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
        'new shell in emptied Place',
      );
      child.write('\x02q');
      await until(() => exitCode() !== undefined, 'orderly exit');

      assert.equal(exitCode(), 0);

      const final = JSON.parse(await readFile(configPath, 'utf8')) as Config;

      assert.equal(
        final.places[0]?.agents.length,
        1,
        'shutdown preserves session definitions',
      );
      assert.equal(final.theme, 'catppuccin-latte');
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

for (const startup of ['saved', '--place'] as const) {
  void test(
    `startup ${startup} with a Git Place stays interactive while Rezi initializes`,
    { timeout: 15000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'ducks-startup-'));
      const configPath = join(directory, 'config.json');

      await new Promise<void>((resolve, reject) =>
        execFile(
          // eslint-disable-next-line sonarjs/no-os-command-from-path -- Resolve the user's installed Git; arguments are passed separately.
          'git',
          ['-C', directory, 'init', '--initial-branch=main', '--template='],
          (error) => {
            if (error) {
              reject(new Error('Git command failed', { cause: error }));
            } else {
              resolve();
            }
          },
        ),
      );
      if (startup === 'saved') {
        const config = defaultConfig();
        config.theme = 'github-light';
        config.profiles.push({
          id: 'shell',
          name: 'Shell',
          executable: '/bin/sh',
          args: ['-i'],
        });
        config.places.push({
          id: 'p',
          name: 'Saved project',
          directory,
          agents: [
            { id: 'a', name: 'Shell', profileId: 'shell', kind: 'shell' },
            { id: 'b', name: 'Shell 2', profileId: 'claude' },
          ],
          activeAgentId: 'b',
        });
        config.places.push({
          id: 'q',
          name: 'Background',
          directory,
          agents: [{ id: 'c', name: 'Other shell', profileId: 'codex' }],
          activeAgentId: 'c',
        });
        config.activePlaceId = 'p';
        await writeFile(configPath, JSON.stringify(config));
      }

      const { child, screen, tabs, background, until, dispose, exitCode } =
        startTui(
          configPath,
          startup === '--place' ? ['--place', directory] : [],
        );

      try {
        await until(
          () =>
            screen()
              .split('\n')
              .some((line) => /\bmain\s*$/u.test(line.slice(0, SIDEBAR_WIDTH))),
          'branch after startup',
        );
        await delay(150);

        assert.ok(
          !screen().includes('Closing terminals'),
          'startup must not trigger emergency shutdown',
        );

        await until(
          () => /\bsh\b/u.test(tabs()) && hasShellPrompt(screen()),
          'shell starts and takes focus',
        );

        assert.doesNotMatch(screen(), /Running|Starting|Stopped|■/u);
        assert.ok(!screen().includes('Ctrl+B r'));

        if (startup === 'saved') {
          assert.equal(
            background(0, 0),
            getTheme('github-light').colors.sidebar,
            'saved theme is used on startup',
          );

          await until(
            () => screen().includes('Background'),
            'background saved Place is displayed',
          );

          const saved = JSON.parse(
            await readFile(configPath, 'utf8'),
          ) as Config;

          assert.equal(saved.places[0]?.activeAgentId, 'b');
          assert.ok(
            saved.places.every((p) =>
              p.agents.every((a) => a.profileId === 'shell'),
            ),
          );
        }

        child.write("printf 'STARTUP_%s\\n' OK\r");
        await until(
          () => screen().includes('STARTUP_OK'),
          'startup terminal input',
        );
        if (startup === 'saved') {
          child.write('exit\r');
          await until(
            () => (tabs().match(/\bsh\b/gu)?.length ?? 0) === 1,
            'restored neighbour stays running',
          );
          child.write("printf 'RESTORED_%s\\n' NEIGHBOUR\r");
          await until(
            () => screen().includes('RESTORED_NEIGHBOUR'),
            'other restored tab takes input',
          );
        }

        child.write('\x02q');
        await until(() => exitCode() !== undefined, 'clean exit');

        assert.equal(exitCode(), 0);
      } finally {
        dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

/** A tab label can render before the shell has completed interactive startup. */
function hasShellPrompt(screen: string): boolean {
  const terminal = screen
    .split('\n')
    .slice(1, -1)
    .map((line) => line.slice(SIDEBAR_WIDTH + 1))
    .join('\n');

  return /[$#]\s*$/u.test(terminal);
}

void test(
  'native mouse drag highlights terminal text and sends the selection to the host clipboard',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-selection-'));
    const { child, screen, background, clipboard, until, dispose } = startTui(
      join(directory, 'config.json'),
      ['--place', directory],
    );

    try {
      await until(() => hasShellPrompt(screen()), 'shell ready');
      child.write("printf '\\033[2J\\033[H%s\\r\\n' 'hello world'\r");
      await until(
        () =>
          screen()
            .split('\n')[1]
            ?.slice(SIDEBAR_WIDTH + 1)
            .startsWith('hello world') === true,
        'selection fixture',
      );

      const x = SIDEBAR_WIDTH + 2;

      child.write(`\x1b[<0;${x};2M\x1b[<32;${x + 4};2M`);

      const colors = getTheme('catppuccin-mocha').colors;

      await until(
        () => background(x - 1, 1) === colors.accent,
        'drag highlight',
      );

      assert.equal(background(x + 4, 1), colors.bg);

      child.write(`\x1b[<0;${x + 4};2m`);
      await until(() => clipboard.length === 1, 'OSC 52 clipboard write');

      assert.deepEqual(clipboard, ['hello']);

      child.write('\x03');
      await until(
        () => clipboard.length === 2 && background(x - 1, 1) === colors.bg,
        'Ctrl+C copies and clears the selection',
      );

      assert.deepEqual(clipboard, ['hello', 'hello']);
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI preserves left mouse release and relays multiline Unicode copied through the child controlling terminal',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-copy-release-'));
    const fixture = join(directory, 'selection.cjs');
    const events = join(directory, 'events.json');
    const selected = 'Codex: Привет 世界 🦆\nsecond line';
    const encoded = Buffer.from(selected).toString('base64');

    await writeFile(
      fixture,
      `const fs = require('node:fs');
process.stdin.setRawMode(true); process.stdin.resume();
let input = ''; const events = [];
process.stdin.on('data', data => {
  input += data.toString();
  input = input.replace(/\\x1b\\[<(\\d+);(\\d+);(\\d+)([Mm])/g, (event, button, x, y, action) => {
    events.push(event); fs.writeFileSync(${JSON.stringify(events)}, JSON.stringify(events));
    if (button === '0' && action === 'm') fs.writeFileSync('/dev/tty', '\\x1b]52;c;${encoded}\\x07');
    return '';
  });
});
process.stdout.write('\\x1b[?1002h\\x1b[?1006h\\x1b[2J\\x1b[HSELECT_READY hello');`,
    );

    const { child, screen, clipboard, until, dispose } = startTui(
      join(directory, 'config.json'),
      ['--place', directory],
    );

    try {
      await until(() => hasShellPrompt(screen()), 'shell ready');
      child.write(`'${process.execPath}' '${fixture}'\r`);
      await until(
        () => screen().includes('SELECT_READY hello'),
        'selection fixture',
      );

      const x = SIDEBAR_WIDTH + 2;

      child.write(`\x1b[<0;${x};2M\x1b[<32;${x + 4};2M\x1b[<0;${x + 4};2m`);
      await until(async () => {
        const data = await readFile(events, 'utf8').catch(() => '[]');

        return (JSON.parse(data) as string[]).length === 3;
      }, 'mouse gesture received');

      assert.deepEqual(JSON.parse(await readFile(events, 'utf8')), [
        '\x1b[<0;1;1M',
        '\x1b[<32;5;1M',
        '\x1b[<0;5;1m',
      ]);

      await until(() => clipboard.length === 1, 'copy on left release');

      assert.deepEqual(clipboard, [selected]);
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test(
  'native TUI displays only completed synchronized frames',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ducks-sync-'));
    const marker = join(directory, 'partial');
    const fixture = join(directory, 'sync.cjs');

    await writeFile(
      fixture,
      `process.stdin.setRawMode(true);process.stdin.resume();
    process.stdout.write('\\x1b[2J\\x1b[HOLD_FRAME');
    process.stdin.on('data',d=>{
      if(d.toString().includes('n')){
        process.stdout.write('\\x1b[?2026h\\x1b[HPARTIAL_FRAME');
        require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');
      }
      if(d.toString().includes('e'))process.stdout.write('\\x1b[HFINAL_FRAME  \\x1b[?2026l');
    });`,
    );

    const { child, screen, until, dispose } = startTui(
      join(directory, 'config.json'),
      ['--place', directory],
    );

    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

    try {
      await until(() => hasShellPrompt(screen()), 'shell ready');
      child.write(`${quote(process.execPath)} ${quote(fixture)}\r`);
      await until(
        () =>
          screen()
            .split('\n')[1]
            ?.slice(SIDEBAR_WIDTH + 1)
            .startsWith('OLD_FRAME') === true,
        'initial frame',
      );
      child.write('n');
      await until(
        async () =>
          (await readFile(marker, 'utf8').catch(() => '')) === 'ready',
        'partial output produced',
      );
      await delay(150);

      assert.ok(
        screen()
          .split('\n')[1]
          ?.slice(SIDEBAR_WIDTH + 1)
          .startsWith('OLD_FRAME'),
      );
      assert.equal(screen().includes('PARTIAL_FRAME'), false);

      child.write('e');
      await until(
        () =>
          screen()
            .split('\n')[1]
            ?.slice(SIDEBAR_WIDTH + 1)
            .startsWith('FINAL_FRAME') === true,
        'completed frame',
      );
    } finally {
      dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
