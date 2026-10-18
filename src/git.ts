import { execFile } from 'node:child_process';

export type BranchReader = (directory: string) => Promise<string | undefined>;

function git(directory: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      // eslint-disable-next-line sonarjs/no-os-command-from-path -- Resolve the user's installed Git; arguments are passed separately.
      'git',
      ['-C', directory, ...args],
      {
        timeout: 1500,
        maxBuffer: 65536,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      },
      (error, stdout) => {
        const value = stdout.trim();
        resolve(
          // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
          !error && value && !/[\x00-\x1f\x7f]/u.test(value)
            ? value
            : undefined,
        );
      },
    );
  });
}

export const readGitBranch: BranchReader = async (directory) => {
  const branch = await git(directory, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ]);
  if (branch) {
    return branch;
  }

  const commit = await git(directory, ['rev-parse', '--short', 'HEAD']);

  return commit ? `detached:${commit}` : undefined;
};
