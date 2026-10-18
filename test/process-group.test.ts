import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { defined } from '../src/defined.js';
import { signalGroup } from '../src/terminal/processes.js';
import { SessionManager } from '../src/terminal/SessionManager.js';
import { FakeScreen } from './FakeScreen.js';
import type { PtyProcess } from '../src/terminal/contracts.js';

void test(
  'shutdown kills a stubborn descendant after the leader has exited',
  { timeout: 10000 },
  async (t) => {
    const probe = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      timeout: 1000,
    });
    if (probe.error && 'code' in probe.error && probe.error.code === 'EPERM') {
      t.skip('This sandbox denies child process execution (EPERM)');

      return;
    }

    assert.ifError(probe.error);

    const source = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e', "process.on('SIGTERM',()=>{}); console.log('CHILD:'+process.pid); setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});
    child.stdout.pipe(process.stdout);
    setInterval(()=>{},1000);`;
    let descendant = 0;
    let leader = 0;
    const manager = new SessionManager(
      () => {
        const child = spawn(process.execPath, ['-e', source], {
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        leader = defined(child.pid);
        child.stdout.on('data', (data: Buffer) => {
          const match = /CHILD:(\d+)/u.exec(data.toString());
          if (match) {
            descendant = Number(match[1]);
          }
        });

        const processAdapter: PtyProcess = {
          pid: leader,
          write: (data) => {
            child.stdin.write(data);
          },
          pause: () => {
            child.stdout.pause();
          },
          resume: () => {
            child.stdout.resume();
          },
          resize: () => {
            /* Test stub. */
          },
          onData: (handler) => {
            const callback = (data: Buffer) => {
              handler(data.toString());
            };

            child.stdout.on('data', callback);

            return {
              dispose: () => {
                child.stdout.off('data', callback);
              },
            };
          },
          onExit: (handler) => {
            const callback = (code: number | null) => {
              handler({ exitCode: code ?? 143 });
            };

            child.on('exit', callback);

            return {
              dispose: () => {
                child.off('exit', callback);
              },
            };
          },
        };

        return processAdapter;
      },
      (c, r) => new FakeScreen(c, r),
      () => {
        /* Test stub. */
      },
      signalGroup,
      50,
    );

    try {
      manager.start(
        { id: 'a', name: 'Fixture', profileId: 'fixture' },
        {
          id: 'p',
          name: 'P',
          directory: '/tmp',
          agents: [],
          activeAgentId: null,
        },
        {
          id: 'fixture',
          name: 'Fixture',
          executable: process.execPath,
          args: [],
        },
      );

      for (let i = 0; i < 300 && !descendant; i++) {
        await delay(10);
      }

      assert.ok(descendant, 'Descendant started');

      await manager.stop('a');

      // A killed descendant can briefly remain a zombie before init reaps it.
      let alive = true;
      for (let i = 0; i < 300; i++) {
        try {
          process.kill(descendant, 0);
          if (process.platform === 'linux') {
            const { readFile } = await import('node:fs/promises');
            const state = await readFile(
              `/proc/${descendant}/stat`,
              'utf8',
            ).catch(() => '');
            if (!state || /^\d+ \(.*\) Z /u.test(state)) {
              alive = false;
              break;
            }
          }
        } catch {
          alive = false;
          break;
        }

        await delay(10);
      }

      assert.equal(alive, false, 'No running descendant remains');
      assert.equal(manager.sessions.get('a')?.status, 'stopped');
    } finally {
      if (leader) {
        signalGroup(leader, 'SIGKILL');
      }

      await manager.shutdown();
    }
  },
);

void test(
  'closing a real interactive shell kills stubborn foreground and background jobs but preserves another terminal',
  { timeout: 15000 },
  async () => {
    const { mkdtemp, writeFile, readFile, rm } =
      await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { spawnPty, createScreen } =
      await import('../src/terminal/native.js');
    const directory = await mkdtemp(join(tmpdir(), 'ducks-job-groups-'));
    const fixture = join(directory, 'job.cjs');

    await writeFile(
      fixture,
      `process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});
      require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`,
    );

    const manager = new SessionManager(
      spawnPty,
      createScreen,
      () => {
        /* Test stub. */
      },
      signalGroup,
      150,
    );

    const agent = { id: 'shell', name: 'Shell', profileId: 'shell' };
    const place = {
      id: 'p',
      name: 'p',
      directory,
      agents: [],
      activeAgentId: null,
    };

    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

    const launched: number[] = [];

    const waitPid = async (name: string) => {
      for (let i = 0; i < 200; i++) {
        const pid = Number(
          await readFile(join(directory, name), 'utf8').catch(() => ''),
        );
        if (pid) {
          launched.push(pid);

          return pid;
        }

        await delay(10);
      }

      throw new Error('Job did not start: ' + name);
    };

    const alive = async (pid: number) => {
      try {
        process.kill(pid, 0);
        if (process.platform !== 'linux') {
          return true;
        }

        const stat = await readFile(`/proc/${pid}/stat`, 'utf8');

        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z';
      } catch {
        return false;
      }
    };

    try {
      manager.start(agent, place, {
        id: 'shell',
        name: 'shell',
        executable: '/bin/sh',
        args: ['-i'],
      });
      manager.start({ ...agent, id: 'other' }, place, {
        id: 'other',
        name: 'other',
        executable: process.execPath,
        args: [fixture, join(directory, 'other')],
      });

      const other = await waitPid('other');

      manager.write(
        'shell',
        `${quote(process.execPath)} ${quote(fixture)} ${quote(join(directory, 'background'))} &\r`,
      );

      const background = await waitPid('background');

      manager.write(
        'shell',
        `${quote(process.execPath)} ${quote(fixture)} ${quote(join(directory, 'foreground'))}\r`,
      );

      const foreground = await waitPid('foreground');

      await manager.remove('shell');

      for (
        let i = 0;
        i < 100 && ((await alive(background)) || (await alive(foreground)));
        i++
      ) {
        await delay(10);
      }

      assert.equal(await alive(background), false, 'background group stopped');
      assert.equal(await alive(foreground), false, 'foreground group stopped');
      assert.equal(await alive(other), true, 'another terminal is unaffected');
    } finally {
      await manager.shutdown();

      for (const pid of launched) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }

      await rm(directory, { recursive: true, force: true });
    }
  },
);
