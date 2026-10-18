import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

// @xterm/addon-unicode-graphemes 0.4.0 reads pooled Node buffers from offset 0.
// Keep this fix until https://github.com/xtermjs/xterm.js/pull/6080 is released.
const entry = createRequire(import.meta.url).resolve(
  '@xterm/addon-unicode-graphemes',
);
for (const path of [entry, entry.replace(/\.js$/u, '.mjs')]) {
  const source = await readFile(path, 'utf8');
  const fixed = source.replace(
    /new DataView\((\w+)\.buffer\)/gu,
    'new DataView($1.buffer,$1.byteOffset,$1.byteLength)',
  );
  if (
    !/new DataView\((\w+)\.buffer,\1\.byteOffset,\1\.byteLength\)/u.test(fixed)
  )
    throw new Error(
      'Unicode addon changed; review and remove or update the byteOffset patch',
    );

  if (fixed !== source) await writeFile(path, fixed);
}
