import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityTracker } from '../src/terminal/ActivityTracker.js';
import {
  identifyAgent,
  parseProcStat,
  processNameFromArgv,
} from '../src/terminal/agents.js';
import { FakeScreen } from './FakeScreen.js';

const codex = { id: '42:Codex', name: 'Codex' };

void test('agent identity uses executable and runtime script positions, not user arguments', () => {
  assert.equal(identifyAgent(['/usr/bin/codex']), 'Codex');
  assert.equal(
    identifyAgent(['/nix/store/package/bin/.codex-wrapped']),
    'Codex',
  );
  assert.equal(
    identifyAgent([
      'node',
      '/npm/node_modules/@anthropic-ai/claude-code/cli.js',
    ]),
    'Claude Code',
  );
  assert.equal(
    identifyAgent([
      'node',
      '--import',
      'tsx',
      '/npm/node_modules/@openai/codex/bin/codex.js',
    ]),
    'Codex',
  );
  assert.equal(identifyAgent(['node', 'other.js', 'codex']), null);
  assert.equal(identifyAgent(['node', '-e', 'codex']), null);
  assert.equal(identifyAgent(['node', "-econsole.log('x')", 'codex']), null);
  assert.equal(identifyAgent(['python3', '-c', 'claude']), null);
  assert.equal(identifyAgent(['/bin/sh', '-c', 'codex']), null);
  assert.equal(identifyAgent(['rg', 'codex']), null);
  assert.equal(identifyAgent(['/bin/zsh', '-i']), null);
  assert.equal(processNameFromArgv(['/bin/mc']), 'mc');
  assert.equal(processNameFromArgv(['-zsh']), 'zsh');
  assert.equal(
    processNameFromArgv(['/nix/store/package/bin/.mc-wrapped']),
    'mc',
  );
  assert.equal(
    processNameFromArgv([
      'node',
      '/npm/node_modules/@openai/codex/bin/codex.js',
    ]),
    'codex',
  );
});

void test('Linux stat parser locates the foreground group despite spaces and parentheses in comm', () => {
  assert.deepEqual(
    parseProcStat('123 (shell (with spaces)) S 1 123 123 34816 456 4194304'),
    { group: 123, foreground: 456 },
  );
  assert.equal(parseProcStat('gone'), null);
});

void test('title signals and trust/permission dialogs keep quiet working agents and blockers visible', () => {
  const tracker = new ActivityTracker(),
    screen = new FakeScreen(80, 24);
  screen.content = '›';
  screen.title = '⠙ Codex';

  assert.equal(tracker.evaluate(codex, screen, 10000), 'working');
  assert.equal(tracker.evaluate(codex, screen, 60000), 'working');

  screen.title = 'Action Required — Codex';

  assert.equal(tracker.evaluate(codex, screen, 61000), 'waiting');

  screen.title = '';
  screen.content = 'Trust this folder?\nTrust and continue\nEsc to cancel';

  assert.equal(tracker.evaluate(codex, screen, 62000), 'waiting');

  screen.content = 'Do you want to proceed?\n❯ 1. Yes\n2. No\nEsc to cancel';

  assert.equal(
    tracker.evaluate({ id: '43:Claude', name: 'Claude Code' }, screen, 63000),
    'waiting',
  );

  screen.content = '✻ Thinking… (8s)\n❯';

  assert.equal(
    tracker.evaluate({ id: '43:Claude', name: 'Claude Code' }, screen, 64000),
    'working',
  );
});

void test('typing and bracketed paste leave activity alone; submission suppresses stale prompt evidence', () => {
  const tracker = new ActivityTracker(),
    screen = new FakeScreen(80, 24);
  screen.content = '›';

  assert.equal(tracker.evaluate(codex, screen, 10000), 'idle');

  tracker.input('hello', screen, 11000);
  tracker.input('\x1b[200~hello\nworld\x1b[201~', screen, 11000);

  assert.equal(tracker.evaluate(codex, screen, 11000), 'idle');

  tracker.input('\r', screen, 12000);

  assert.equal(tracker.evaluate(codex, screen, 12000), 'working');
  assert.equal(tracker.evaluate(codex, screen, 14000), 'working');

  screen.content = '• Answer\n›';

  assert.equal(tracker.evaluate(codex, screen, 14001), 'idle');

  screen.content = 'Allow command?\nEnter to confirm';

  assert.equal(tracker.evaluate(codex, screen, 15000), 'waiting');

  tracker.input('\r', screen, 16000);

  assert.equal(tracker.evaluate(codex, screen, 16000), 'working');
  assert.equal(
    tracker.evaluate(codex, screen, 20000),
    'waiting',
    'an unanswered dialog is observed again after submission grace',
  );
});

void test('fallback activity settles after output stops and disappears when the shell regains foreground', () => {
  const tracker = new ActivityTracker(),
    screen = new FakeScreen(80, 24);
  screen.content = 'Processing log';
  tracker.output(10000);

  assert.equal(tracker.evaluate(codex, screen, 10000), 'working');
  assert.equal(tracker.evaluate(codex, screen, 11501), 'idle');
  assert.equal(tracker.evaluate(null, screen, 12000), null);

  screen.content = 'Allow command?\nEnter to confirm';
  tracker.output(13000);

  assert.equal(
    tracker.evaluate(null, screen, 13000),
    null,
    'a shell or ordinary command never gets agent status',
  );
});
