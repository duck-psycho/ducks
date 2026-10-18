import pty from 'node-pty';
import { XtermScreen } from './XtermScreen.js';
import type { SpawnPty, ScreenFactory } from './contracts.js';
export const spawnPty: SpawnPty = (profile, cwd, cols, rows) => {
  // The embedded PTY supports RGB independently of the outer terminal's flags.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '3',
    CLICOLOR: '1',
  };

  delete env['NO_COLOR'];

  return pty.spawn(profile.executable, profile.args, {
    cwd,
    cols,
    rows,
    name: 'xterm-256color',
    env,
  });
};

export const createScreen: ScreenFactory = (cols, rows) =>
  new XtermScreen(cols, rows);
