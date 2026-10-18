#!/usr/bin/env node
import { resolve } from 'node:path';
import { ConfigStore } from './ConfigStore.js';

const help = `ducks — CLI agent multiplexer\n\nUsage: ducks [--config <file>] [--place <directory>]\n\n  --place <directory>  Add/select a Place; new Places open a shell\n  --config <file>      Use an alternate configuration file\n  --help              Show help\n  --version           Show version\n\nInside the TUI, press Ctrl+B followed by:\n  ? Commands help · p Prompt · f Focus Places · a New agent · s New Place · n/b Tabs · z Close agent · x Close Place · m Settings · q Quit\n  ↑/↓ Navigate Places · Enter Focus terminal\nUse cd in the shell to choose the Place directory.\nRepeat Ctrl+B to send it to the agent. Shift+PgUp/PgDn scroll history.\n`;

type CliOptions = {
  customConfig: string | undefined;
  directory: string | undefined;
  done: boolean;
};

function printInformation(arg: string | undefined): boolean {
  if (arg === '--help' || arg === '-h') {
    process.stdout.write(help);

    return true;
  }

  if (arg === '--version') {
    process.stdout.write('0.1.0\n');

    return true;
  }

  return false;
}

function parseArgs(args: string[]): CliOptions {
  let customConfig: string | undefined;
  let directory: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (printInformation(arg)) {
      return { customConfig, directory, done: true };
    }

    if (arg !== '--config' && arg !== '--place') {
      throw new Error(`Unknown argument: ${String(arg)}. Use --help.`);
    }

    const value = args[++i];
    if (!value || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }

    if (arg === '--config') {
      customConfig = resolve(value);
    } else {
      directory = value;
    }
  }

  return { customConfig, directory, done: false };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.done) {
    return;
  }

  const { customConfig, directory } = options;
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    throw new Error('This version supports Linux and macOS');
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'ducks needs an interactive terminal. Use --help for usage.',
    );
  }

  const store = new ConfigStore(customConfig);
  const config = await store.load();

  // Help/config errors remain useful even when native dependencies are missing.
  const [
    { createNodeApp },
    { Controller },
    { SessionManager },
    native,
    { XtermScreen },
    rezi,
  ] = await Promise.all([
    import('@rezi-ui/node'),
    import('./Controller.js'),
    import('./terminal/SessionManager.js'),
    import('./terminal/native.js'),
    import('./terminal/XtermScreen.js'),
    import('./ui/rezi.js'),
  ]);

  const app = createNodeApp({
    initialState: { revision: 0 },
    config: { executionMode: 'worker', fpsCap: 30 },
  });
  let disposed = false;
  let renderReady = false;
  let repaint = false;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  // Rezi rejects updates while its backend is starting or stopping. The first
  // frame reads the controller directly, including any changes made at startup.
  const changed = () => {
    if (renderReady && !disposed) {
      app.update((state: Readonly<{ revision: number }>) => ({
        revision: state.revision + 1,
      }));
    }
  };

  const sessions: InstanceType<typeof SessionManager> = new SessionManager(
    native.spawnPty,
    (cols, rows) => new XtermScreen(cols, rows, () => controller.theme),
    changed,
  );
  const controller = new Controller(
    config,
    sessions,
    store,
    changed,
    async () => {
      renderReady = false;
      await app.ready();
      await app.stop();
    },
  );
  controller.handle({
    kind: 'resize',
    cols: process.stdout.columns,
    rows: process.stdout.rows,
  });
  controller.restoreTerminals();
  if (directory) {
    await controller.addPlace(directory);
  }

  app.view(() => rezi.view(controller, repaint));
  const detach = rezi.attachInput(app, controller);

  // The native backend polls dimensions. A shrink/grow burst can end at the
  // original size between polls while the terminal has already moved cells.
  // SIGWINCH catches that case even when no Rezi resize event is emitted.
  const resized = () => {
    if (!renderReady || disposed || controller.closing) {
      return;
    }

    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!renderReady || disposed || controller.closing) {
        return;
      }

      repaint = !repaint;
      changed();
    }, 100);
  };

  process.on('SIGWINCH', resized);

  const detachResize = app.onEvent((event) => {
    if (event.kind === 'engine' && event.event.kind === 'resize') {
      resized();
    }
  });

  // Quiet agents still need animation frames while they are working.
  const animationTimer = setInterval(() => {
    if (!renderReady || disposed || controller.closing) {
      return;
    }

    for (const session of sessions.sessions.values()) {
      if (session.activity === 'working') {
        changed();

        return;
      }
    }
  }, rezi.WORKING_FRAME_MS);
  animationTimer.unref();

  let fatal: unknown;

  const shutdown = (error?: unknown) => {
    if (error !== undefined) {
      fatal ??= error;
      renderReady = false;
    }

    void controller.quit().catch((error: unknown) => {
      fatal ??= error;
    });
  };

  const interrupt = () => {
    shutdown();
  };

  const exception = (error: Error) => {
    shutdown(error);
  };

  const rejection = (reason: unknown) => {
    shutdown(reason);
  };

  process.on('SIGTERM', interrupt);
  process.on('SIGHUP', interrupt);
  process.on('SIGINT', interrupt);
  process.on('uncaughtException', exception);
  process.on('unhandledRejection', rejection);

  try {
    const running = app.run();
    await Promise.all([
      running,
      app.ready().then(() => {
        if (disposed || controller.closing) {
          return;
        }

        renderReady = true;
        changed();
        controller.git.watch(() => config.places);
      }),
    ]);
  } finally {
    renderReady = false;
    disposed = true;

    detach();
    detachResize();
    clearTimeout(resizeTimer);
    clearInterval(animationTimer);
    process.off('SIGWINCH', resized);
    controller.git.dispose();

    process.off('SIGTERM', interrupt);
    process.off('SIGHUP', interrupt);
    process.off('SIGINT', interrupt);
    process.off('uncaughtException', exception);
    process.off('unhandledRejection', rejection);

    await sessions.shutdown().catch((error: unknown) => {
      fatal ??= error;
    });
    await store.flush().catch((error: unknown) => {
      fatal ??= error;
    });

    try {
      app.dispose();
    } finally {
      process.stdin.setRawMode(false);
      process.stdout.write(
        '\x1b[0m\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?1049l',
      );
    }
  }

  if (fatal !== undefined) {
    throw fatal instanceof Error
      ? fatal
      : new Error('Terminal runtime failed', { cause: fatal });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `ducks: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
