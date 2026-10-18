import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActivityTracker } from '../src/terminal/ActivityTracker.js';
import { XtermScreen } from '../src/terminal/XtermScreen.js';
import { FakeScreen } from './FakeScreen.js';
import corpus from './fixtures/activity-screens.json' with { type: 'json' };

const names: Record<string, string> = { codex: 'Codex', claude: 'Claude Code' };
void test('JSON activity rules classify rendered Unicode screens at 80 and 120 columns, independent of history scrolling', async () => {
  for (const columns of [80, 120]) {
    const screen = new XtermScreen(columns, 40);

    try {
      for (const fixture of corpus.cases) {
        await new Promise<void>((resolve) => {
          screen.write(
            '\x1bc' +
              `\x1b]0;${fixture.title}\x07` +
              (fixture.progress ? `\x1b]9;${fixture.progress}\x07` : '') +
              fixture.text.replaceAll('\n', '\r\n'),
            resolve,
          );
        });

        const tracker = new ActivityTracker();
        const agent = { id: fixture.agent, name: names[fixture.agent] ?? '' };
        const actual = tracker.evaluate(agent, screen, 10000);

        assert.equal(
          actual,
          fixture.state === 'preserve' ? 'idle' : fixture.state,
          `${fixture.id} at ${columns} columns`,
        );

        screen.scroll(100);

        assert.equal(
          tracker.evaluate(agent, screen, 20000),
          actual,
          fixture.id,
        );
      }
    } finally {
      screen.dispose();
    }
  }
});

void test('transcript and model-picker rules preserve all prior states without leaking between agents', () => {
  for (const fixture of corpus.cases.filter(
    (screen) => screen.state === 'preserve',
  )) {
    for (const state of ['idle', 'working', 'waiting'] as const) {
      const screen = new FakeScreen(80, 24);
      const tracker = new ActivityTracker();
      const agent = { id: fixture.agent, name: names[fixture.agent] ?? '' };
      const titles = {
        working: '⠙ Thinking',
        waiting: 'Action Required',
        idle: '',
      };

      screen.title = titles[state];
      screen.content = state === 'idle' ? '›' : '';

      assert.equal(tracker.evaluate(agent, screen, 10000), state);

      screen.title = fixture.title;
      screen.content = fixture.text;

      assert.equal(tracker.evaluate(agent, screen, 11000), state, fixture.id);
      assert.equal(tracker.evaluate(null, screen, 12000), null);
      assert.equal(
        tracker.evaluate({ ...agent, id: 'new-process' }, screen, 13000),
        'idle',
      );
    }
  }
});

void test('fresh approval screens override submission grace while unchanged old approvals remain suppressed', () => {
  const tracker = new ActivityTracker();
  const screen = new FakeScreen(80, 24);
  const agent = { id: 'codex', name: 'Codex' };

  screen.content = '›';

  assert.equal(tracker.evaluate(agent, screen, 10000), 'idle');

  tracker.input('\r', screen, 11000);

  assert.equal(tracker.evaluate(agent, screen, 11001), 'working');

  screen.content = 'Allow command?\nenter to confirm';

  assert.equal(tracker.evaluate(agent, screen, 11002), 'waiting');

  tracker.input('\r', screen, 12000);

  assert.equal(tracker.evaluate(agent, screen, 12001), 'working');

  screen.content = 'Allow command?\nnew command\nenter to confirm';

  assert.equal(tracker.evaluate(agent, screen, 12002), 'waiting');
});

void test('OSC progress updates activity across PTY chunks, ignores malformed values and resets with the terminal', async () => {
  const screen = new XtermScreen(80, 24);
  const tracker = new ActivityTracker();
  const agent = { id: 'claude', name: 'Claude Code' };

  tracker.output(10000);

  const state = () => tracker.evaluate(agent, screen, 10000);

  const write = (data: string) =>
    new Promise<void>((resolve) => {
      screen.write(data, resolve);
    });

  try {
    await write('\x1b]9;4;3\x07');

    assert.equal(state(), 'working');

    await write('\x1b]9;4;');

    assert.equal(
      state(),
      'working',
      'incomplete progress does not change activity',
    );

    await write('0\x07');

    assert.equal(state(), 'idle');

    await write('\x1b]9;4;not-a-state\x07');

    assert.equal(state(), 'idle');

    await write('\x1b]9;4;1;50\x1b');
    await write('\\');

    assert.equal(state(), 'working');

    await write('\x1b]9;4;0\x07');

    assert.equal(state(), 'idle');

    await write('\x1bc');

    assert.equal(state(), 'working', 'reset clears the previous idle signal');
  } finally {
    screen.dispose();
  }
});
