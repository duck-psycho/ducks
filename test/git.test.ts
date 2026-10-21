import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defined } from '../src/defined.js';
import { readGitStatus } from '../src/git.js';
import { GitBranches } from '../src/GitBranches.js';
import type { GitStatus } from '../src/git.js';
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
    assert.equal(await readGitStatus(root), undefined);
    assert.equal(await readGitStatus(join(root, 'missing')), undefined);

    await runGit(repo, 'init', '--initial-branch=main', '--template=');

    assert.equal((await readGitStatus(nested))?.branch, 'main');

    await runGit(repo, 'commit', '--allow-empty', '-m', 'fixture');
    await runGit(repo, 'worktree', 'add', '-b', 'feature/worktree', worktree);

    assert.equal((await readGitStatus(worktree))?.branch, 'feature/worktree');
    assert.equal((await readGitStatus(repo))?.branch, 'main');

    await runGit(repo, 'switch', '-c', 'topic');

    assert.equal((await readGitStatus(nested))?.branch, 'topic');

    await runGit(repo, 'checkout', '--detach');

    assert.match(
      defined((await readGitStatus(repo))?.branch),
      /^detached:[a-f0-9]+$/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('branch refresh observes branch changes and removes Git labels after cd out of a repository', async () => {
  let branch: string | undefined = 'main';
  let displayed: string | undefined;
  const monitor = new GitBranches(
    () => {
      displayed = monitor.getStatus(place)?.branch;
    },
    (directory) =>
      Promise.resolve(
        directory === '/repo' && branch
          ? { branch, dirty: false, ahead: 0, behind: 0 }
          : undefined,
      ),
  );

  const place: Place = {
    id: 'p',
    name: 'Project',
    directory: '/repo',
    agents: [],
    activeAgentId: null,
  };

  await monitor.refresh([place]);

  assert.equal(monitor.getStatus(place)?.branch, 'main');
  assert.equal(displayed, 'main');

  branch = 'topic';
  await monitor.refresh([place]);

  assert.equal(monitor.getStatus(place)?.branch, 'topic');
  assert.equal(displayed, 'topic');

  place.directory = '/elsewhere';

  assert.equal(
    monitor.getStatus(place)?.branch,
    undefined,
    'old branches never appear on a different directory',
  );

  await monitor.refresh([place]);

  assert.equal(monitor.getStatus(place)?.branch, undefined);
  assert.equal(displayed, undefined);

  monitor.dispose();
});

void test('Git status tracks untracked, staged and unstaged files and commits ahead of and behind upstream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ducks-git-status-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const nested = join(repo, 'nested');
  await mkdir(nested, { recursive: true });
  await mkdir(remote);

  try {
    await runGit(repo, 'init', '--initial-branch=main', '--template=');
    assert.deepEqual(await readGitStatus(repo), {
      branch: 'main',
      dirty: false,
      ahead: undefined,
      behind: undefined,
    });
    await writeFile(join(repo, 'file\n# branch.ab +999 -0'), 'initial');
    assert.equal((await readGitStatus(nested))?.dirty, true);
    await runGit(repo, 'add', '.');
    assert.equal((await readGitStatus(repo))?.dirty, true);
    await runGit(repo, 'commit', '-m', 'initial');
    await runGit(remote, 'init', '--bare', '--template=');
    await runGit(repo, 'remote', 'add', 'origin', remote);
    await runGit(repo, 'push', '-u', 'origin', 'main');
    assert.deepEqual(await readGitStatus(nested), {
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 0,
    });
    await writeFile(join(repo, 'file\n# branch.ab +999 -0'), 'modified');
    assert.deepEqual(await readGitStatus(nested), {
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
    });
    await runGit(repo, 'commit', '-am', 'change');
    await runGit(repo, 'commit', '--allow-empty', '-m', 'another');
    assert.deepEqual(await readGitStatus(repo), {
      branch: 'main',
      dirty: false,
      ahead: 2,
      behind: 0,
    });
    await runGit(repo, 'push');
    assert.equal((await readGitStatus(repo))?.ahead, 0);
    await runGit(repo, 'config', 'status.showUntrackedFiles', 'no');
    await runGit(repo, 'config', 'status.aheadBehind', 'false');
    await writeFile(join(repo, 'new-file'), 'untracked');
    assert.deepEqual(await readGitStatus(nested), {
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
    });
    await rm(join(repo, 'new-file'));
    await mkdir(join(repo, '.git', 'info'));
    await writeFile(join(repo, '.git', 'info', 'exclude'), 'ignored\n');
    await writeFile(join(repo, 'ignored'), 'ignored');
    assert.equal((await readGitStatus(repo))?.dirty, false);

    const peer = join(root, 'peer');
    await runGit(root, 'clone', '--branch', 'main', remote, peer);
    await runGit(peer, 'commit', '--allow-empty', '-m', 'remote change');
    await runGit(
      peer,
      'commit',
      '--allow-empty',
      '-m',
      'another remote change',
    );
    await runGit(peer, 'push');
    await runGit(repo, 'fetch', 'origin');
    assert.deepEqual(await readGitStatus(nested), {
      branch: 'main',
      dirty: false,
      ahead: 0,
      behind: 2,
    });
    await runGit(repo, 'commit', '--allow-empty', '-m', 'local change');
    assert.deepEqual(await readGitStatus(repo), {
      branch: 'main',
      dirty: false,
      ahead: 1,
      behind: 2,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test('status refresh repaints dirty, ahead and behind changes on the same branch', async () => {
  let status: GitStatus = { branch: 'main', dirty: false, ahead: 0, behind: 0 };
  let changes = 0;
  const monitor = new GitBranches(
    () => {
      changes++;
    },
    () => Promise.resolve({ ...status }),
  );
  const place: Place = {
    id: 'p',
    name: 'Project',
    directory: '/repo',
    agents: [],
    activeAgentId: null,
  };
  await monitor.refresh([place]);
  await monitor.refresh([place]);
  assert.equal(changes, 1);
  status = { ...status, dirty: true };
  await monitor.refresh([place]);
  assert.equal(changes, 2);
  assert.equal(monitor.getStatus(place)?.dirty, true);
  status = { ...status, dirty: false, ahead: 2 };
  await monitor.refresh([place]);
  assert.equal(changes, 3);
  assert.deepEqual(monitor.getStatus(place), status);
  status = { ...status, ahead: 0 };
  await monitor.refresh([place]);
  assert.equal(changes, 4);
  status = { ...status, behind: 3 };
  await monitor.refresh([place]);
  assert.equal(changes, 5);
  assert.equal(monitor.getStatus(place)?.behind, 3);
  await monitor.refresh([place]);
  assert.equal(changes, 5);
  status = { ...status, behind: 0 };
  await monitor.refresh([place]);
  assert.equal(changes, 6);
  assert.equal(monitor.getStatus(place)?.behind, 0);
  monitor.dispose();
});

void test('slow Git reads cannot overwrite a new directory, removed Place or disposed monitor', async () => {
  const replies = new Map<string, (status: GitStatus) => void>();
  let displayed: string | undefined;
  const monitor = new GitBranches(
    () => {
      displayed = monitor.getStatus(place)?.branch;
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
  defined(replies.get('/new'))({
    branch: 'new-branch',
    dirty: false,
    ahead: 0,
    behind: 0,
  });
  await next;
  defined(replies.get('/old'))({
    branch: 'old-branch',
    dirty: false,
    ahead: 0,
    behind: 0,
  });
  await old;

  assert.equal(monitor.getStatus(place)?.branch, 'new-branch');
  assert.equal(displayed, 'new-branch');

  const removed = monitor.refresh([place]);

  await Promise.resolve();
  await monitor.refresh([]);
  defined(replies.get('/new'))({
    branch: 'removed-branch',
    dirty: false,
    ahead: 0,
    behind: 0,
  });
  await removed;

  assert.equal(monitor.getStatus(place)?.branch, undefined);
  assert.equal(
    displayed,
    'new-branch',
    'a removed Place cannot publish a late branch',
  );

  const disposed = monitor.refresh([place]);

  await Promise.resolve();
  monitor.dispose();
  defined(replies.get('/new'))({
    branch: 'late-branch',
    dirty: false,
    ahead: 0,
    behind: 0,
  });
  await disposed;

  assert.equal(monitor.getStatus(place)?.branch, undefined);
  assert.equal(
    displayed,
    'new-branch',
    'a disposed monitor cannot publish a late branch',
  );
});
