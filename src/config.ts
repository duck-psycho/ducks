import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from './model.js';
import { DEFAULT_THEME, isThemeId } from './themes.js';
import type { AgentDefinition, Config, Place, Profile } from './model.js';
const PROFILE_ID = 'profile id';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object');
  }

  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    // eslint-disable-next-line no-control-regex -- Terminal control bytes are intentional for parsing and sanitization.
    /[\x00-\x1f\x7f]/u.test(value)
  ) {
    throw new Error(`Invalid ${name}`);
  }

  return value;
}

function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected an array');
  }

  return value;
}

function selection(value: unknown): string | null {
  return value === null ? null : text(value, 'selection');
}

function unique(values: string[], kind: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Duplicate ${kind}`);
  }
}

export function parseConfig(value: unknown): Config {
  const root = object(value);
  if (root['version'] !== 1) {
    throw new Error(`Unsupported config version: ${String(root['version'])}`);
  }

  const theme = root['theme'] === undefined ? DEFAULT_THEME.id : root['theme'];
  if (!isThemeId(theme)) {
    throw new Error(`Unknown theme: ${JSON.stringify(theme)}`);
  }

  const sidebarWidth =
    root['sidebarWidth'] === undefined
      ? DEFAULT_SIDEBAR_WIDTH
      : root['sidebarWidth'];
  if (
    typeof sidebarWidth !== 'number' ||
    !Number.isSafeInteger(sidebarWidth) ||
    sidebarWidth < MIN_SIDEBAR_WIDTH
  ) {
    throw new Error('Invalid sidebarWidth');
  }

  const profiles: Profile[] = list(root['profiles']).map((value) => {
    const p = object(value);

    return {
      id: text(p['id'], PROFILE_ID),
      name: text(p['name'], 'profile name'),
      executable: text(p['executable'], 'executable'),
      args: list(p['args']).map((arg) => {
        if (typeof arg !== 'string' || arg.includes('\0')) {
          throw new Error('Invalid argument');
        }

        return arg;
      }),
    };
  });

  unique(
    profiles.map((p) => p.id),
    PROFILE_ID,
  );

  const places: Place[] = list(root['places']).map((value) => {
    const p = object(value);
    const directory = text(p['directory'], 'directory');
    if (!isAbsolute(directory)) {
      throw new Error('Place directory must be absolute');
    }

    const agents: AgentDefinition[] = list(p['agents']).map((value) => {
      const a = object(value);
      const profileId = text(a['profileId'], PROFILE_ID);
      if (!profiles.some((p) => p.id === profileId)) {
        throw new Error(`Unknown profile: ${profileId}`);
      }

      if (a['kind'] !== undefined && a['kind'] !== 'shell') {
        throw new Error('Invalid session kind');
      }

      return {
        id: text(a['id'], 'agent id'),
        name: text(a['name'], 'agent name'),
        profileId,
        ...(a['kind'] === 'shell' ? { kind: 'shell' as const } : {}),
      };
    });

    const activeAgentId = selection(p['activeAgentId']);
    if (p['autoName'] !== undefined && typeof p['autoName'] !== 'boolean') {
      throw new Error('Invalid autoName');
    }

    return {
      id: text(p['id'], 'place id'),
      name: text(p['name'], 'place name'),
      directory,
      agents,
      activeAgentId: agents.some((a) => a.id === activeAgentId)
        ? activeAgentId
        : (agents[0]?.id ?? null),
      ...(typeof p['autoName'] === 'boolean'
        ? { autoName: p['autoName'] }
        : {}),
    };
  });

  unique(
    places.map((p) => p.id),
    'place id',
  );
  unique(
    places.flatMap((p) => p.agents.map((a) => a.id)),
    'agent id',
  );

  const activePlaceId = selection(root['activePlaceId']);

  return {
    version: 1,
    theme,
    sidebarWidth,
    profiles,
    places,
    activePlaceId: places.some((p) => p.id === activePlaceId)
      ? activePlaceId
      : (places[0]?.id ?? null),
  };
}

export async function canonicalDirectory(input: string): Promise<string> {
  let expanded = input;
  if (input === '~') {
    expanded = homedir();
  } else if (input.startsWith('~/')) {
    expanded = join(homedir(), input.slice(2));
  }

  const directory = await realpath(resolve(expanded));
  if (!(await stat(directory)).isDirectory()) {
    throw new Error('Choose a directory, not a file');
  }

  return directory;
}
