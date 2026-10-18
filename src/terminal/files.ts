import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Profile } from '../model.js';
import type { TerminalTextPosition } from './contracts.js';

export type FileLink = {
  candidates: string[];
  start: number;
  end: number;
};

/** Share the clickable range between opening a file and highlighting it. */
export function fileLinkAt(
  position: Pick<TerminalTextPosition, 'text' | 'index'> | null,
): FileLink | null {
  if (!position) {
    return null;
  }

  const { text, index } = position;
  const candidates: string[] = [];
  for (const match of text.matchAll(
    /`([^`]+)`|"([^"]+)"|'([^']+)'|[^\s`"']+/gu,
  )) {
    const start = match.index;
    if (index < start || index >= start + match[0].length) {
      continue;
    }

    const token = match[1] ?? match[2] ?? match[3] ?? match[0];
    const bare = trimToken(token);
    for (const value of [token, bare]) {
      candidates.push(
        value,
        value.replace(/(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/u, ''),
      );
    }

    const paths = [...new Set(candidates)].filter(
      (value) =>
        // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
        value && !/[\x00-\x1f\x7f]/u.test(value) && !value.includes('://'),
    );
    if (!paths.length) {
      return null;
    }

    const rangeStart = start + match[0].indexOf(token) + token.indexOf(bare);

    return {
      candidates: paths,
      start: rangeStart,
      end: rangeStart + bare.length,
    };
  }

  return null;
}

export function fileCandidates(
  position: Pick<TerminalTextPosition, 'text' | 'index'> | null,
): string[] {
  return fileLinkAt(position)?.candidates ?? [];
}

export async function resolveTextFile(
  candidates: string[],
  directory: string,
  home: string = homedir(),
): Promise<string | null> {
  for (const candidate of candidates) {
    const path = resolve(
      directory,
      candidate.startsWith('~/')
        ? resolve(home, candidate.slice(2))
        : candidate,
    );

    try {
      if (await isTextFile(path)) {
        return path;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EISDIR') {
        throw error;
      }
    }
  }

  return null;
}

export function editorProfile(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): Profile {
  const editor = env['EDITOR']?.trim();
  if (!editor) {
    throw new Error('Set $EDITOR to open text files with Ctrl+click');
  }

  // $EDITOR is a user-supplied command (possibly with quoted flags). The file
  // is a separate positional argument and is never interpolated into shell code.
  return {
    id: 'editor',
    name: 'Editor',
    executable: '/bin/sh',
    args: ['-c', `exec ${editor} "$1"`, 'ducks-editor', file],
  };
}

function textSample(data: Buffer): boolean {
  const utf16 =
    data.length >= 2 &&
    ((data[0] === 0xff && data[1] === 0xfe) ||
      (data[0] === 0xfe && data[1] === 0xff));
  let text = data.toString('latin1');
  if (utf16) {
    text = new TextDecoder(data[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(
      data,
    );
  }

  // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
  return !/[\x00-\x08\x0e-\x1f\x7f]/u.test(text);
}

async function isTextFile(path: string): Promise<boolean> {
  // Nonblocking open also protects against paths referring to FIFOs.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);

  try {
    if (!(await file.stat()).isFile()) {
      return false;
    }

    const sample = Buffer.alloc(8192);
    const { bytesRead } = await file.read(sample, 0, sample.length, 0);

    return textSample(sample.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

function trimToken(token: string): string {
  let start = 0,
    end = token.length;
  while (start < end && '([{<'.includes(token.charAt(start))) {
    start++;
  }

  while (end > start && ')]}>.,;:!?'.includes(token.charAt(end - 1))) {
    end--;
  }

  return token.slice(start, end);
}
