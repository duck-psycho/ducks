import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export type SignalGroup = (
  pid: number,
  signal: 'SIGHUP' | 'SIGTERM' | 'SIGKILL' | 0,
) => void;

export type ProcessGroupReader = (
  pid: number,
  known: ReadonlySet<number>,
) => Promise<number[]>;

export const signalGroup: SignalGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (signal === 0 || (error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
};

/** PTY shells are session leaders; job control creates additional groups. */
export const readSessionGroups: ProcessGroupReader = async (pid, known) => {
  if (process.platform === 'linux') {
    const entries = await readdir('/proc');
    const groups = await Promise.all(
      entries
        .filter((name) => /^\d+$/u.test(name))
        .map(async (name) => {
          const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(
            () => '',
          );
          const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');

          return Number(fields[3]) === pid ? Number(fields[2]) : 0;
        }),
    );

    return [...new Set(groups.filter((group) => group > 0))];
  }

  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,pgid=,tty='],
      { timeout: 1000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error('Cannot enumerate terminal processes', { cause: error }),
          );
        } else {
          resolve(terminalGroups(stdout, pid, known));
        }
      },
    );
  });
};

export function terminalGroups(
  output: string,
  pid: number,
  known: ReadonlySet<number>,
): number[] {
  const rows = output
    .trim()
    .split('\n')
    .map((line) => {
      const [process, group, terminal = '?'] = line.trim().split(/\s+/u);

      return { pid: Number(process), group: Number(group), terminal };
    });
  const terminals = new Set(
    rows
      .filter((row) => row.pid === pid || known.has(row.group))
      .map((row) => row.terminal)
      .filter((terminal) => terminal !== '?' && terminal !== '??'),
  );

  return [
    ...new Set(
      rows
        .filter((row) => terminals.has(row.terminal))
        .map((row) => row.group)
        .filter((group) => group > 0),
    ),
  ];
}

export async function stopProcessGroups(
  pid: number,
  signal: 'SIGHUP' | 'SIGTERM',
  graceMs: number,
  send: SignalGroup,
  readGroups: ProcessGroupReader,
): Promise<void> {
  const groups = new Set<number>([pid]);

  const discover = async () => {
    for (const group of await readGroups(pid, groups)) {
      if (groups.has(group)) {
        continue;
      }

      groups.add(group);
      send(group, signal);
    }
  };

  // Capture jobs before hanging up the shell, which may exit immediately.
  await discover();
  send(pid, signal);

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await discover();

    for (const group of groups) {
      try {
        send(group, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }

        groups.delete(group);
      }
    }

    if (!groups.size) {
      return;
    }

    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }

  // Include jobs created by signal handlers near the end of the grace period.
  await discover();

  for (const group of groups) {
    send(group, 'SIGKILL');
  }
}
