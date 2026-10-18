import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pipeOutput } from '../src/terminal/output.js';
import { FakePty } from './FakePty.js';
import { FakeScreen } from './FakeScreen.js';

void test('queued PTY output reaches the screen in order without loss or duplication', async () => {
  const child = new FakePty();
  const screen = new FakeScreen(80, 24);
  const pending: (() => void)[] = [];

  screen.write = (data, done) => {
    pending.push(() => {
      screen.content += data;
      done?.();
    });
  };

  let rendered = '';
  const subscription = pipeOutput(
    child,
    screen,
    () => {
      /* Test stub. */
    },
    () => {
      rendered = screen.content;
    },
  );

  const chunks = ['first\r\n', 'Привет 🦆\r\n', 'last'];
  for (const chunk of chunks) {
    child.output(chunk);
  }

  for (const complete of pending.splice(0)) {
    complete();
  }

  await Promise.resolve();

  assert.equal(screen.content, chunks.join(''));
  assert.equal(rendered, chunks.join(''));

  child.output('tail');
  subscription.dispose();
  pending.shift()?.();
  await Promise.resolve();

  assert.equal(
    rendered,
    chunks.join(''),
    'a late parse callback cannot update a closed session',
  );
});

void test('closing an output pipe ignores subsequent PTY output', () => {
  const child = new FakePty();
  const screen = new FakeScreen(80, 24);
  const subscription = pipeOutput(
    child,
    screen,
    () => {
      /* Test stub. */
    },
    () => {
      /* Test stub. */
    },
  );

  child.output('before close');
  subscription.dispose();
  subscription.dispose();
  child.output('ignored');

  assert.equal(screen.content, 'before close');
});

void test('closing a pipe cancels an already queued screen notification', async () => {
  const child = new FakePty();
  const screen = new FakeScreen(80, 24);
  let rendered = '';
  const subscription = pipeOutput(
    child,
    screen,
    () => {
      /* Test stub. */
    },
    () => {
      rendered = screen.content;
    },
  );

  child.output('closed');
  subscription.dispose();
  await Promise.resolve();

  assert.equal(rendered, '');
});
