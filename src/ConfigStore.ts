import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { parseConfig } from './config.js';
import { defaultConfig } from './model.js';
import type { Config } from './model.js';
function configPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['XDG_CONFIG_HOME'];

  return join(
    base && isAbsolute(base) ? base : join(homedir(), '.config'),
    'ducks',
    'config.json',
  );
}

export class ConfigStore {
  private _pending: Promise<void> = Promise.resolve();
  public constructor(public readonly path: string = configPath()) {}

  public async load(): Promise<Config> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return defaultConfig();
      }

      throw error;
    }

    try {
      return parseConfig(JSON.parse(raw));
    } catch (error) {
      throw new Error(
        `Cannot read ${this.path}: ${String(error)}. The file was left unchanged.`,
        { cause: error },
      );
    }
  }

  public save(config: Config): Promise<void> {
    const data = JSON.stringify(parseConfig(config), null, 2) + '\n';
    const operation = this._pending
      .catch(() => {
        /* No callback registered. */
      })
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });

        const temporary = `${this.path}.${randomUUID()}.tmp`;

        try {
          await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
          await rename(temporary, this.path);
        } finally {
          await unlink(temporary).catch(() => {
            /* No callback registered. */
          });
        }
      });

    this._pending = operation;

    return operation;
  }

  public async flush(): Promise<void> {
    await this._pending;
  }
}
