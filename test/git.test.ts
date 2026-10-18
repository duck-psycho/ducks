import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defined } from '../src/defined.js';
import { readGitBranch } from '../src/git.js';
import { GitBranches } from '../src/GitBranches.js';
import type { Place } from '../src/model.js';

function runGit(directory: string, ...args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- Resolve the user's installed Git; arguments are passed separately.
      'git',
      [
        '-C',
        directory,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Ducks Test',
        '-c',
        'user.email=test@example.invalid',
        ...args,
      ],
      {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
      (error) => {
        if (error) {
          reject(new Error('Git command failed', { cause: error }));
        } else {
          resolve();
        }
      },
    ),
  );
}

void test('Git branch detection handles unborn branches, nested directories, worktrees, detached HEAD and non-repositories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ducks-git-'));
  const repo = join(root, 'repo'),
    nested = join(repo, 'nested'),
    worktree = join(root, 'worktree');

  await mkdir(nested, { recursive: true });

  try {
    assert.equal(await readGitBranch(root), undefined);
    assert.equal(await readGitBranch(join(root, 'missing')), undefined);

    await runGit(repo, 'init', '--initial-branch=main', '--template=');

    assert.equal(await readGitBranch(nested), 'main');

    await runGit(repo, 'commit', '--allow-empty', '-m', 'fixture');
    await runGit(repo, 'worktree', 'add', '-b', 'feature/worktree', worktree);

    assert.equal(await readGitBranch(worktree), 'feature/worktree');
    assert.equal(await readGitBranch(repo), 'main');

    await runGit(repo, 'switch', '-c', 'topic');

    assert.equal(await readGitBranch(nested), 'topic');

    await runGit(repo, 'checkout', '--detach');

    assert.match(defined(await readGitBranch(repo)), /^detached:[a-f0-9]+$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('branch refresh observes branch changes and removes Git labels after cd out of a repository', async () => {
  let branch: string | undefined = 'main';
  let displayed: string | undefined;
  const monitor = new GitBranches(
    () => {
      displayed = monitor.get(place);
    },
    (directory) => Promise.resolve(directory === '/repo' ? branch : undefined),
  );

  const place: Place = {
    id: 'p',
    name: 'Project',
    directory: '/repo',
    agents: [],
    activeAgentId: null,
  };

  await monitor.refresh([place]);

  assert.equal(monitor.get(place), 'main');
  assert.equal(displayed, 'main');

  branch = 'topic';
  await monitor.refresh([place]);

  assert.equal(monitor.get(place), 'topic');
  assert.equal(displayed, 'topic');

  place.directory = '/elsewhere';

  assert.equal(
    monitor.get(place),
    undefined,
    'old branches never appear on a different directory',
  );

  await monitor.refresh([place]);

  assert.equal(monitor.get(place), undefined);
  assert.equal(displayed, undefined);

  monitor.dispose();
});

void test('slow Git reads cannot overwrite a new directory, removed Place or disposed monitor', async () => {
  const replies = new Map<string, (branch: string) => void>();
  let displayed: string | undefined;
  const monitor = new GitBranches(
    () => {
      displayed = monitor.get(place);
    },
    (directory) =>
      new Promise((resolve) => {
        replies.set(directory, resolve);
      }),
  );

  const place: Place = {
    id: 'p',
    name: 'Project',
    directory: '/old',
    agents: [],
    activeAgentId: null,
  };
  const old = monitor.refresh([place]);

  await Promise.resolve();
  place.directory = '/new';

  const next = monitor.refresh([place]);

  await Promise.resolve();
  defined(replies.get('/new'))('new-branch');
  await next;
  defined(replies.get('/old'))('old-branch');
  await old;

  assert.equal(monitor.get(place), 'new-branch');
  assert.equal(displayed, 'new-branch');

  const removed = monitor.refresh([place]);

  await Promise.resolve();
  await monitor.refresh([]);
  defined(replies.get('/new'))('removed-branch');
  await removed;

  assert.equal(monitor.get(place), undefined);
  assert.equal(
    displayed,
    'new-branch',
    'a removed Place cannot publish a late branch',
  );

  const disposed = monitor.refresh([place]);

  await Promise.resolve();
  monitor.dispose();
  defined(replies.get('/new'))('late-branch');
  await disposed;

  assert.equal(monitor.get(place), undefined);
  assert.equal(
    displayed,
    'new-branch',
    'a disposed monitor cannot publish a late branch',
  );
});
