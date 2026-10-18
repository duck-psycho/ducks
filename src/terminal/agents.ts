import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { defined } from '../defined.js';
import type { PtyProcess } from './contracts.js';

export type ForegroundAgent = {
  id: string;
  name: string;
};

export type ForegroundProcess = {
  name: string;
  agent: ForegroundAgent | null;
};

// undefined means observation failed; null means the foreground job disappeared.
export type ForegroundProcessReader = (
  child: PtyProcess,
) => Promise<ForegroundProcess | null | undefined>;

const CLAUDE_CODE = 'Claude Code';

const aliases: Record<string, string> = {
  codex: 'Codex',
  claude: CLAUDE_CODE,
  'claude-code': CLAUDE_CODE,
  gemini: 'Gemini',
  opencode: 'OpenCode',
  'cursor-agent': 'Cursor',
  copilot: 'Copilot',
  'github-copilot': 'Copilot',
  droid: 'Droid',
  amp: 'Amp',
  grok: 'Grok',
  pi: 'pi',
  hermes: 'Hermes',
  kimi: 'Kimi',
  'kiro-cli': 'Kiro',
};

function nameFromPath(path: string): string | null {
  const name = basename(path)
    .toLowerCase()
    .replace(/^\./u, '')
    .replace(/-wrapped$/u, '')
    .replace(/\.(?:js|cjs|mjs)$/u, '');
  if (aliases[name]) {
    return aliases[name];
  }

  const packages: [RegExp, string][] = [
    [/\/node_modules\/@openai\/codex\//u, 'Codex'],
    [/\/node_modules\/@anthropic-ai\/claude-code\//u, CLAUDE_CODE],
    [/\/node_modules\/@google\/gemini-cli\//u, 'Gemini'],
    [/\/node_modules\/opencode-ai\//u, 'OpenCode'],
    [/\/node_modules\/[^/]+\/pi-coding-agent\//u, 'pi'],
  ];

  return packages.find(([pattern]) => pattern.test(path))?.[1] ?? null;
}

/** Match executable/script positions, never prompt text or arbitrary arguments. */
export function identifyAgent(argv: ReadonlyArray<string>): string | null {
  const executable = argv[0];
  if (!executable) {
    return null;
  }

  const direct = nameFromPath(executable);
  if (direct) {
    return direct;
  }

  if (!/^(?:node(?:js)?|bun|python[\d.]*)$/u.test(basename(executable))) {
    return null;
  }

  for (let i = 1; i < argv.length; i++) {
    const arg = defined(argv[i]);
    if (/^(?:-[epcm]|--(?:eval|print)(?:$|=))/u.test(arg)) {
      return null;
    }

    if (
      [
        '--require',
        '--import',
        '--loader',
        '--experimental-loader',
        '--inspect-port',
        '-r',
        '-W',
        '-X',
      ].includes(arg)
    ) {
      i++;
      continue;
    }

    if (arg === '--') {
      return nameFromPath(argv[i + 1] ?? '');
    }

    if (arg.startsWith('-')) {
      continue;
    }

    return nameFromPath(arg);
  }

  return null;
}

export function processNameFromArgv(argv: ReadonlyArray<string>): string {
  const agent = identifyAgent(argv);
  const agentCommands: Record<string, string> = {
    [CLAUDE_CODE]: 'claude',
    Cursor: 'cursor-agent',
    Kiro: 'kiro-cli',
  };
  if (agent) {
    return agentCommands[agent] ?? agent.toLowerCase();
  }

  return (
    basename(argv[0] ?? '')
      .replace(/^[-.]/u, '')
      .replace(/-wrapped$/u, '') || 'terminal'
  );
}

function foregroundProcess(group: number, argv: string[]): ForegroundProcess {
  const name = identifyAgent(argv);

  return {
    name: processNameFromArgv(argv),
    agent: name ? { id: `${group}:${name}`, name } : null,
  };
}

type ProcStat = {
  group: number;
  foreground: number;
};

export function parseProcStat(stat: string): ProcStat | null {
  // comm can contain spaces and parentheses; fields after its final ')' start at state.
  const end = stat.lastIndexOf(')');
  if (end < 0) {
    return null;
  }

  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/u);
  const group = Number(fields[2]),
    foreground = Number(fields[5]);

  return Number.isInteger(group) && group > 0 && Number.isInteger(foreground)
    ? { group, foreground }
    : null;
}

async function linuxProcess(
  pid: number,
): Promise<ForegroundProcess | null | undefined> {
  try {
    const root = parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'));
    if (!root || root.foreground <= 0) {
      return undefined;
    }

    const read = async (candidate: number) => {
      const [stat, cmdline] = await Promise.all([
        readFile(`/proc/${candidate}/stat`, 'utf8'),
        readFile(`/proc/${candidate}/cmdline`, 'utf8'),
      ]);
      const parsed = parseProcStat(stat);

      return parsed?.group === root.foreground
        ? foregroundProcess(root.foreground, cmdline.split('\0'))
        : null;
    };

    const leader = await read(root.foreground).catch(() => null);
    if (leader?.agent || root.foreground === root.group) {
      return leader;
    } // shell prompt; ignore background jobs

    // npm launchers may be the group leader while their agent is a child in that group.
    return (await scanLinuxChildren(root.foreground, read)) ?? leader;
  } catch {
    return undefined;
  }
}

type PsProcess = {
  pid: number;
  parent: number;
  group: number;
  foreground: boolean;
  argv: string[];
};

// One bounded ps snapshot is shared by all tabs on macOS.
let macSnapshot:
  | { at: number; pending: boolean; result: Promise<PsProcess[] | undefined> }
  | undefined;
function macProcesses(): Promise<PsProcess[] | undefined> {
  if (
    macSnapshot &&
    (macSnapshot.pending || Date.now() - macSnapshot.at < 250)
  ) {
    return macSnapshot.result;
  }

  const result = new Promise<PsProcess[] | undefined>((resolve) => {
    execFile(
      '/bin/ps',
      ['-axww', '-o', 'pid=,ppid=,pgid=,stat=,command='],
      { timeout: 1000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);

          return;
        }

        resolve(stdout.split('\n').flatMap(parsePsLine));
      },
    );
  });
  const snapshot = { at: Date.now(), pending: true, result };

  macSnapshot = snapshot;
  void result.then(() => {
    snapshot.pending = false;
    snapshot.at = Date.now();
  });

  return result;
}

export const readForegroundProcess: ForegroundProcessReader = async (child) => {
  if (process.platform === 'linux') {
    return linuxProcess(child.pid);
  }

  if (process.platform === 'darwin') {
    return macForegroundProcess(child);
  }

  // eslint-disable-next-line sonarjs/no-redundant-jump -- Explicit return is required by noImplicitReturns.
  return;
};

async function scanLinuxChildren(
  group: number,
  read: (pid: number) => Promise<ForegroundProcess | null>,
): Promise<ForegroundProcess | null> {
  const queue = [group];
  const seen = new Set<number>();
  while (queue.length && seen.size < 64) {
    const parent = defined(queue.shift());
    if (seen.has(parent)) {
      continue;
    }

    seen.add(parent);

    const children = await readFile(
      `/proc/${parent}/task/${parent}/children`,
      'utf8',
    ).catch(() => '');
    for (const token of children.trim().split(/\s+/u)) {
      const child = Number(token);
      if (!Number.isInteger(child) || child <= 0) {
        continue;
      }

      const candidate = await read(child).catch(() => null);
      if (candidate?.agent) {
        return candidate;
      }

      queue.push(child);
    }
  }

  return null;
}

async function macForegroundProcess(
  child: PtyProcess,
): Promise<ForegroundProcess | null | undefined> {
  const processes = await macProcesses();
  if (!processes) {
    return;
  }

  const descendants = processDescendants(processes, child.pid);
  const foreground = processes.filter(
    (p) => descendants.has(p.pid) && p.foreground,
  );
  const leader = foreground.find((p) => p.pid === p.group) ?? foreground[0];
  if (!leader) {
    return null;
  }

  const main = foregroundProcess(leader.group, leader.argv);
  if (main.agent) {
    return main;
  }

  for (const p of foreground) {
    const candidate = foregroundProcess(p.group, p.argv);
    if (candidate.agent) {
      return candidate;
    }
  }

  return main;
}

function processDescendants(processes: PsProcess[], pid: number): Set<number> {
  const descendants = new Set([pid]);
  let added = true;
  while (added) {
    added = false;

    for (const p of processes) {
      if (descendants.has(p.parent) && !descendants.has(p.pid)) {
        descendants.add(p.pid);
        added = true;
      }
    }
  }

  return descendants;
}

function parsePsLine(line: string): PsProcess[] {
  const fields = line.trim().split(/\s+/u);
  if (
    fields.length < 5 ||
    !fields.slice(0, 3).every((field) => /^\d+$/u.test(field))
  ) {
    return [];
  }

  return [
    {
      pid: Number(fields[0]),
      parent: Number(fields[1]),
      group: Number(fields[2]),
      foreground: defined(fields[3]).includes('+'),
      argv: fields.slice(4),
    },
  ];
}
