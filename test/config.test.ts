import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalDirectory, parseConfig } from '../src/config.js';
import { ConfigStore } from '../src/ConfigStore.js';
import { defined } from '../src/defined.js';
import { defaultConfig } from '../src/model.js';

void test('missing config gets defaults; concurrent saves persist the latest complete config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ducks-config-'));

  try {
    const store = new ConfigStore(join(directory, 'nested', 'config.json'));
    const config = await store.load();

    assert.deepEqual(config, defaultConfig());

    const first = store.save(config);

    config.places.push({
      id: 'p',
      name: 'Example',
      directory,
      agents: [],
      activeAgentId: null,
    });
    config.activePlaceId = 'p';

    const second = store.save(config);

    await Promise.all([first, second]);
    await store.flush();

    assert.deepEqual(await store.load(), config);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('invalid or unsupported config is not overwritten', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ducks-config-'));

  try {
    const path = join(directory, 'config.json');

    await writeFile(path, '{"version":42}');

    await assert.rejects(
      new ConfigStore(path).load(),
      /Unsupported config version/,
    );
    assert.equal(await readFile(path, 'utf8'), '{"version":42}');

    await writeFile(path, 'bad JSON');

    await assert.rejects(new ConfigStore(path).load(), /left unchanged/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('legacy configs retain the default theme and saved theme choices survive reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ducks-theme-'));

  try {
    const { theme, ...legacy } = defaultConfig();

    assert.equal(parseConfig(legacy).theme, theme);
    assert.throws(
      () => parseConfig({ ...legacy, theme: 'missing' }),
      /Unknown theme/u,
    );

    const store = new ConfigStore(join(directory, 'config.json'));
    const config = parseConfig({ ...legacy, theme: 'github-light' });

    await store.save(config);

    assert.equal((await store.load()).theme, 'github-light');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('config rejects duplicate session ids and unknown profiles; stale selections recover', () => {
  const config = defaultConfig();
  config.places = [
    {
      id: 'p',
      name: 'P',
      directory: '/tmp',
      agents: [{ id: 'a', name: 'A', profileId: 'codex' }],
      activeAgentId: 'missing',
    },
  ];
  config.activePlaceId = 'missing';

  assert.equal(parseConfig(config).places[0]?.activeAgentId, 'a');
  assert.equal(parseConfig(config).activePlaceId, 'p');

  defined(config.places[0]).agents.push({
    id: 'a',
    name: 'B',
    profileId: 'codex',
  });

  assert.throws(() => parseConfig(config), /Duplicate agent/);

  defined(config.places[0]).agents = [
    { id: 'b', name: 'B', profileId: 'unknown' },
  ];

  assert.throws(() => parseConfig(config), /Unknown profile/);
});

void test('project paths resolve symlinks and reject files or missing directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ducks-path-'));

  try {
    await symlink(directory, join(directory, 'link'));

    assert.equal(await canonicalDirectory(join(directory, 'link')), directory);

    await writeFile(join(directory, 'file'), 'x');

    await assert.rejects(
      canonicalDirectory(join(directory, 'file')),
      /not a file/,
    );
    await assert.rejects(canonicalDirectory(join(directory, 'missing')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
