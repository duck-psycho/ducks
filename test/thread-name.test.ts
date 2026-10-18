import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ThreadNameTracker } from '../src/terminal/ThreadNameTracker.js';

const codex = { id: '42:Codex', name: 'Codex' };
const claude = { id: '43:Claude Code', name: 'Claude Code' };
// eslint-disable-next-line sonarjs/publicly-writable-directories -- Literal fixture path; this test performs no writes there.
const directory = '/tmp/project';

void test('thread names exclude agent activity and project segments from Codex and Claude titles', () => {
  assert.equal(
    ThreadNameTracker.fromTitle(codex, 'Fix auth | project', directory),
    'Fix auth',
  );
  assert.equal(
    ThreadNameTracker.fromTitle(codex, '⠙ Fix auth | project', directory),
    'Fix auth',
  );
  assert.equal(
    ThreadNameTracker.fromTitle(
      codex,
      '[ ! ] Action Required | Fix auth | project',
      directory,
    ),
    'Fix auth',
  );
  assert.equal(
    ThreadNameTracker.fromTitle(
      codex,
      '[ . ] Action Required | Fix auth | project',
      directory,
    ),
    'Fix auth',
  );
  assert.equal(
    ThreadNameTracker.fromTitle(
      codex,
      '● [ ! ] Action Required | Fix auth | project',
      directory,
    ),
    'Fix auth',
  );
  assert.equal(
    ThreadNameTracker.fromTitle(codex, 'Codex — Fix auth', directory),
    'Fix auth',
  );
  assert.equal(
    ThreadNameTracker.fromTitle(
      claude,
      '✳ Исправить авторизацию 世界',
      directory,
    ),
    'Исправить авторизацию 世界',
  );
  assert.equal(
    ThreadNameTracker.fromTitle(claude, '◐ Fix auth', directory),
    'Fix auth',
  );
});

void test('generic app, version, shell directory and status-only titles are not thread names', () => {
  for (const title of [
    '',
    'Codex',
    'project',
    '⠙ project',
    'Action Required',
    'Codex | project',
    'Generating title | project',
    '⠙ | project',
  ]) {
    assert.equal(
      ThreadNameTracker.fromTitle(codex, title, directory),
      null,
      title,
    );
  }

  for (const title of [
    'Claude Code',
    'Claude Code v2.1.132',
    '✳ Claude Code',
    'project',
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- Literal fixture path; this test performs no writes there.
    '/tmp/project',
    '2.1.132',
    'Working',
  ]) {
    assert.equal(
      ThreadNameTracker.fromTitle(claude, title, directory),
      null,
      title,
    );
  }
});

void test('thread titles follow renames, survive temporary activity titles and clear on return to shell', () => {
  const tracker = new ThreadNameTracker();

  // Agent output may arrive before its foreground process is recognized.
  assert.equal(tracker.update(null, 'Fix auth | project', directory), null);
  assert.equal(
    tracker.update(codex, 'Fix auth | project', directory),
    'Fix auth',
  );
  assert.equal(
    tracker.update(codex, '[ ! ] Action Required', directory),
    'Fix auth',
  );
  assert.equal(
    tracker.update(codex, 'New title | project', directory),
    'New title',
  );
  assert.equal(tracker.update(null, 'New title | project', directory), null);

  const next = { ...codex, id: '44:Codex' };

  assert.equal(
    tracker.update(next, 'New title | project', directory),
    null,
    'a new process cannot inherit the previous thread',
  );
  assert.equal(
    tracker.update(next, 'Other thread | project', directory),
    'Other thread',
  );
  assert.equal(
    tracker.update(next, 'project', directory),
    null,
    'a new unnamed thread falls back to Shell',
  );
  assert.equal(tracker.update(next, 'Again | project', directory), 'Again');
  assert.equal(tracker.update(next, '', directory), null);
});
