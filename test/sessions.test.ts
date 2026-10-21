import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defined } from '../src/defined.js';
import { defaultConfig } from '../src/model.js';
import { SessionManager } from '../src/terminal/SessionManager.js';
import { FakePty } from './FakePty.js';
import { FakeScreen } from './FakeScreen.js';
import type { ForegroundProcess } from '../src/terminal/agents.js';

const place = {
  id: 'p',
  name: 'Project',
  directory: '/tmp',
  agents: [],
  activeAgentId: null,
};
const agent = { id: 'a', name: 'Agent', profileId: 'codex' };
const profile = defined(defaultConfig().profiles[0]);

void test('sessions transition from stopped to running to exited/error, and restart with a fresh buffer', () => {
  const children: FakePty[] = [];
  const manager = new SessionManager(
    () => {
      const child = new FakePty();
      children.push(child);

      return child;
    },
    (c, r) => new FakeScreen(c, r),
    () => {
      /* Test stub. */
    },
  );

  assert.equal(manager.ensure(agent).status, 'stopped');

  manager.start(agent, place, profile);

  assert.equal(manager.sessions.get('a')?.status, 'running');

  defined(children[0]).output('hello');

  assert.equal(
    (manager.sessions.get('a')?.screen as FakeScreen).content,
    'hello',
  );

  defined(children[0]).exit(0);

  assert.equal(manager.sessions.get('a')?.status, 'exited');

  manager.start(agent, place, profile);

  assert.equal((manager.sessions.get('a')?.screen as FakeScreen).content, '');

  defined(children[1]).exit(7);

  assert.equal(manager.sessions.get('a')?.status, 'error');
  assert.match(defined(defined(manager.sessions.get('a')).error), /7/);
});
void test('missing executable is a visible error and does not kill the manager', () => {
  const manager = new SessionManager(
    () => {
      throw new Error('ENOENT');
    },
    (c, r) => new FakeScreen(c, r),
    () => {
      /* Test stub. */
    },
  );

  manager.start(agent, place, profile);

  assert.equal(manager.sessions.get('a')?.status, 'error');
  assert.match(defined(defined(manager.sessions.get('a')).error), /ENOENT/);
});
void test('stop is idempotent, kills the group after its leader exits, and blocks restart during stop', async () => {
  const children: FakePty[] = [];
  const signals: (string | number)[] = [];
  const leaderExited = Promise.withResolvers<undefined>();
  const finishStop = Promise.withResolvers<number[]>();
  const manager = new SessionManager(
    () => {
      const child = new FakePty();
      children.push(child);

      return child;
    },
    (c, r) => new FakeScreen(c, r),
    () => {
      /* Test stub. */
    },
    (_pid, signal) => {
      signals.push(signal);
      if (signal === 'SIGTERM') {
        defined(children[0]).exit(143);
        leaderExited.resolve(undefined);
      }
    },
    0,
    undefined,
    undefined,
    () =>
      signals.includes('SIGTERM') ? finishStop.promise : Promise.resolve([]),
  );

  manager.start(agent, place, profile);

  const screen = defined(manager.sessions.get('a')).screen as FakeScreen;

  try {
    const stopping = manager.stop('a');
    const alsoStopping = manager.stop('a');

    await leaderExited.promise;

    assert.equal(manager.sessions.get('a')?.process, null);
    assert.deepEqual(signals, ['SIGTERM']);

    manager.start(agent, place, profile);

    assert.equal(children.length, 1, 'restart is blocked until stopping ends');
    assert.equal(screen.disposed, false);

    finishStop.resolve([]);
    await Promise.all([stopping, alsoStopping]);

    assert.equal(manager.sessions.get('a')?.status, 'stopped');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  } finally {
    finishStop.resolve([]);
    await manager.shutdown();
  }

  assert.equal(screen.disposed, true);
});

void test('exit notifications exclude deliberate stops and shutdown', async () => {
  const children: FakePty[] = [];
  const exited: string[] = [];
  const manager = new SessionManager(
    () => {
      const child = new FakePty();
      children.push(child);

      return child;
    },
    (c, r) => new FakeScreen(c, r),
    () => {
      /* Test stub. */
    },
    (_pid, signal) => {
      if (signal === 'SIGTERM') {
        defined(children.at(-1)).exit(143);
      }
    },
    0,
  );
  manager.onExit((id) => exited.push(id));
  manager.start(agent, place, profile);
  defined(children[0]).exit(1);

  assert.deepEqual(exited, [agent.id]);

  manager.start(agent, place, profile);
  await manager.stop(agent.id);
  manager.start(agent, place, profile);
  await manager.shutdown();

  assert.deepEqual(exited, [agent.id]);
});

void test('closing a shell hides shutdown output and still kills it after the grace period', async () => {
  const child = new FakePty();
  const signals: (string | number)[] = [];
  const manager = new SessionManager(
    () => child,
    (c, r) => new FakeScreen(c, r),
    () => {
      /* Test stub. */
    },
    (_pid, signal) => {
      signals.push(signal);
      if (signal === 'SIGHUP') {
        child.output('zsh: warning: 1 jobs SIGHUPed\r\n');
      }

      if (signal === 'SIGKILL') {
        child.output('late shutdown output\r\n');
        child.exit(137);
      }
    },
    30,
  );

  manager.start({ ...agent, profileId: 'shell' }, place, {
    id: 'shell',
    name: 'Shell',
    executable: '/bin/sh',
    args: ['-i'],
  });

  const screen = defined(manager.sessions.get(agent.id)).screen as FakeScreen;
  child.output('previous terminal output\r\n');

  try {
    await manager.stop(agent.id);

    assert.equal(screen.content, 'previous terminal output\r\n');
    assert.equal(signals[0], 'SIGHUP');
    assert.equal(signals.at(-1), 'SIGKILL');
    assert.equal(manager.sessions.get(agent.id)?.status, 'stopped');
  } finally {
    await manager.shutdown();
  }
});

void test('a late agent observation cannot restore activity after the terminal was removed', async () => {
  let resolve!: (process: ForegroundProcess) => void;
  const observation = new Promise<ForegroundProcess>((done) => {
    resolve = done;
  });
  const manager = new SessionManager(
    () => new FakePty(),
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
    async () => observation,
  );

  manager.start(agent, place, profile);

  const session = defined(manager.sessions.get(agent.id));
  const refresh = manager.refreshActivity(agent.id);

  await manager.remove(agent.id);
  resolve({ name: 'codex', agent: { id: '42:Codex', name: 'Codex' } });
  await refresh;

  assert.equal(session.activity, null);
  assert.equal(session.threadName, null);
  assert.equal(session.processName, null);
  assert.equal(manager.sessions.has(agent.id), false);
  assert.equal((session.screen as FakeScreen).disposed, true);

  await manager.shutdown();
});
