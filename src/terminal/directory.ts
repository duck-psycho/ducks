import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Profile } from '../model.js';

export type DirectoryReader = (pid: number) => Promise<string | undefined>;

export function shellProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  const executable =
    env['SHELL'] && isAbsolute(env['SHELL']) ? env['SHELL'] : '/bin/sh';

  return { id: 'shell', name: 'Shell', executable, args: ['-i'] };
}

/** Observe the shell itself, so child programs cannot change its Place. */
export const readProcessDirectory: DirectoryReader = async (pid) => {
  if (process.platform === 'linux') {
    try {
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return;
    }
  }

  if (process.platform === 'darwin') {
    return new Promise((resolve) => {
      execFile(
        '/usr/sbin/lsof',
        ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
        { timeout: 1000, maxBuffer: 65536 },
        (error, stdout) => {
          const directory = stdout
            .split('\n')
            .find((line) => line.startsWith('n'))
            ?.slice(1);
          resolve(
            !error && directory && isAbsolute(directory)
              ? directory
              : undefined,
          );
        },
      );
    });
  }

  // eslint-disable-next-line sonarjs/no-redundant-jump -- Explicit return is required by noImplicitReturns.
  return;
};
