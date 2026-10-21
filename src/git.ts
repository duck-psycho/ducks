import { execFile } from 'node:child_process';

export type GitStatus = {
  branch: string;
  dirty: boolean;
  ahead: number | undefined;
  behind: number | undefined;
};

export type GitStatusReader = (
  directory: string,
) => Promise<GitStatus | undefined>;

export const readGitStatus: GitStatusReader = (directory) =>
  new Promise((resolve) => {
    execFile(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- Resolve the user's installed Git; arguments are passed separately.
      'git',
      [
        '-C',
        directory,
        'status',
        '--porcelain=v2',
        '--branch',
        '--ahead-behind',
        '--no-renames',
        '--untracked-files=normal',
        '--ignore-submodules=none',
        '-z',
      ],
      {
        timeout: 1500,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout) => {
        resolve(error ? undefined : parseStatus(stdout));
      },
    );
  });

function parseStatus(output: string): GitStatus | undefined {
  const headers = new Map<string, string>();
  let dirty = false;
  for (const record of output.split('\0')) {
    if (!record) {
      continue;
    }

    if (!record.startsWith('# ')) {
      // All headers precede file entries. Do not interpret filenames as headers.
      dirty = true;
      break;
    }

    const separator = record.indexOf(' ', 2);
    headers.set(record.slice(2, separator), record.slice(separator + 1));
  }

  const branch = statusBranch(headers);
  if (!branch) {
    return undefined;
  }

  const match = /^\+(\d+) -(\d+)$/u.exec(headers.get('branch.ab') ?? '');
  const ahead = match ? Number(match[1]) : undefined;
  const behind = match ? Number(match[2]) : undefined;

  return { branch, dirty, ahead, behind };
}

function statusBranch(headers: Map<string, string>): string | undefined {
  let branch = headers.get('branch.head') ?? '';
  const commit = headers.get('branch.oid') ?? '';
  if (branch === '(detached)') {
    branch = /^[a-f0-9]+$/u.test(commit)
      ? `detached:${commit.slice(0, 7)}`
      : '';
  }

  // eslint-disable-next-line no-control-regex -- Never render terminal control bytes from Git metadata.
  if (!branch || /[\x00-\x1f\x7f]/u.test(branch)) {
    return undefined;
  }

  return branch;
}
