import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  stopProcessGroups,
  terminalGroups,
} from '../src/terminal/processes.js';

void test('macOS group discovery stays on the owned terminal after the shell exits', () => {
  const snapshot =
    '10 10 ttys001\n11 11 ttys001\n12 11 ttys001\n20 20 ttys002\n30 30 ??';

  assert.deepEqual(terminalGroups(snapshot, 10, new Set([10])), [10, 11]);
  assert.deepEqual(
    terminalGroups(
      snapshot.replace('10 10 ttys001\n', ''),
      10,
      new Set([10, 11]),
    ),
    [11],
  );
  assert.deepEqual(terminalGroups(snapshot, 30, new Set([30])), []);
});

void test('shutdown discovers new job groups and kills them even after the shell group disappears', async () => {
  const signals: [number, string | number][] = [];
  let scans = 0;

  await stopProcessGroups(
    10,
    'SIGHUP',
    30,
    (group, signal) => {
      signals.push([group, signal]);
      if (group === 10 && signal === 0) {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }
    },
    () => Promise.resolve(++scans === 1 ? [10, 11] : [11, 12]),
  );

  assert.ok(
    signals.some(([group, signal]) => group === 11 && signal === 'SIGHUP'),
  );
  assert.ok(
    signals.some(([group, signal]) => group === 12 && signal === 'SIGHUP'),
  );
  assert.deepEqual(
    signals.filter(([, signal]) => signal === 'SIGKILL'),
    [
      [11, 'SIGKILL'],
      [12, 'SIGKILL'],
    ],
  );
});
