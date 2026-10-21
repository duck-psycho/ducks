import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { defined } from '../src/defined.js';
import {
  editorProfile,
  fileCandidates,
  fileLinkAt,
  resolveTextFile,
} from '../src/terminal/files.js';

void test('file links recognize quotes, punctuation and source locations at the clicked range', () => {
  for (const [text, clicked, expected] of [
    ['see (src/main.ts:12:3), next', 'main', 'src/main.ts'],
    ['see (src/main.ts:12:3): next', 'main', 'src/main.ts'],
    ['see `src/hello 世界.ts` next', '世界', 'src/hello 世界.ts'],
    ['see "file with spaces.txt" next', 'with', 'file with spaces.txt'],
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- Literal fixture path; the test performs no filesystem writes.
    ["see '/tmp/hello.txt' next", 'hello', '/tmp/hello.txt'],
    ['see ~/README.md#L10 next', 'README', '~/README.md'],
    ['see .gitignore next', 'gitignore', '.gitignore'],
  ]) {
    assert.ok(
      fileCandidates({
        text: defined(text),
        index: defined(text).indexOf(defined(clicked)),
      }).includes(defined(expected)),
      text,
    );
  }

  assert.deepEqual(fileCandidates(null), []);
  assert.deepEqual(fileCandidates({ text: 'file.txt next', index: 8 }), []);
  assert.deepEqual(
    fileCandidates({ text: 'https://example.org/file.txt', index: 12 }),
    [],
  );

  const text = 'see (`src/file name.ts:12:3`), next';
  const link = fileLinkAt({ text, index: text.indexOf('name') });

  assert.equal(
    text.slice(defined(link).start, defined(link).end),
    'src/file name.ts:12:3',
    'the highlighted range excludes surrounding punctuation and quotes',
  );

  const reply = 'Simplified README.md (README.md): kept a short description.';
  for (const index of [
    reply.indexOf('README.md'),
    reply.lastIndexOf('README.md'),
  ]) {
    const mention = defined(fileLinkAt({ text: reply, index }));
    assert.equal(reply.slice(mention.start, mention.end), 'README.md');
    assert.ok(mention.candidates.includes('README.md'));
  }
});

void test('links resolve existing text files, including extensionless, empty and UTF-16 files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ducks-files-'));

  try {
    await mkdir(join(directory, 'sub'));
    await writeFile(join(directory, 'README'), 'Hello 世界\n');
    await writeFile(join(directory, 'empty'), '');
    await writeFile(
      join(directory, 'utf16.txt'),
      Buffer.from('\ufeffHello\n', 'utf16le'),
    );
    await writeFile(
      join(directory, 'binary.txt'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
    );

    for (const file of ['README', 'empty', 'utf16.txt']) {
      assert.equal(
        await resolveTextFile([file], directory),
        join(directory, file),
      );
      assert.equal(
        await resolveTextFile([join(directory, file)], '/'),
        join(directory, file),
      );
    }

    assert.equal(
      await resolveTextFile(['../README'], join(directory, 'sub')),
      join(directory, 'README'),
    );
    assert.equal(
      await resolveTextFile(['~/README'], '/', directory),
      join(directory, 'README'),
    );

    for (const file of ['missing', 'sub', 'binary.txt']) {
      assert.equal(await resolveTextFile([file], directory), null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('editor command preserves quoted flags and passes shell metacharacters as a literal filename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ducks-editor-'));
  const script = join(directory, 'editor fixture.cjs');
  const output = join(directory, 'args.json');
  const file = join(directory, "$(touch INJECTED); 'quoted'.txt");

  try {
    await writeFile(
      script,
      "require('node:fs').writeFileSync(process.env.EDITOR_OUTPUT, JSON.stringify(process.argv.slice(2)));",
    );

    const profile = editorProfile(file, {
      EDITOR: `'${process.execPath}' '${script}' --flag 'two words'`,
    });

    await promisify(execFile)(profile.executable, profile.args, {
      cwd: directory,
      env: { ...process.env, EDITOR_OUTPUT: output },
    });

    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), [
      '--flag',
      'two words',
      file,
    ]);
    await assert.rejects(access(join(directory, 'INJECTED')), {
      code: 'ENOENT',
    });
    assert.throws(() => editorProfile(file, {}), /Set \$EDITOR/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
