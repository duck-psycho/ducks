import type { AgentActivity, AgentStatus, Profile } from '../model.js';
import type { Theme } from '../themes.js';

export type CellStyle = {
  fg: number;
  bg: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strikethrough?: boolean;
};

export type TerminalCell = {
  text: string;
  width: number;
  style: CellStyle;
};

export type TerminalTextCell = {
  x: number;
  y: number;
  width: number;
  index: number;
  length: number;
};

export type TerminalTextPosition = {
  text: string;
  index: number;
  cells: TerminalTextCell[];
};

export type TerminalSnapshot = {
  lines: TerminalCell[][];
  wrapped?: boolean[];
  cursor: { x: number; y: number; visible: boolean };
  scrollOffset: number;
};

export type TerminalModes = {
  alternateScreen: boolean;
  alternateScroll: boolean;
  applicationCursorKeys: boolean;
  bracketedPasteMode: boolean;
  sendFocus: boolean;
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
  mouseEncoding: 'sgr' | 'default';
};

export type TerminalScreen = {
  readonly title: string;
  readonly progress?: string;
  readonly modes: TerminalModes;
  readonly cols: number;
  readonly rows: number;
  write(data: string, done?: () => void): void;
  resize(cols: number, rows: number): void;
  scroll(lines: number): void;
  scrollToBottom(): void;
  snapshot(live?: boolean, theme?: Theme): TerminalSnapshot;
  /** Text on the live screen, independent of scrollback and synchronized output. */
  text(): string;
  textAt(x: number, y: number): TerminalTextPosition | null;
  onResponse(handler: (data: string) => void): void;
  onRefresh?(handler: () => void): void;
  dispose(): void;
};

export type PtyProcess = {
  readonly pid: number;
  write(data: string): void;
  pause(): void;
  resume(): void;
  resize(cols: number, rows: number): void;
  onData(handler: (data: string) => void): { dispose(): void };
  onExit(handler: (event: { exitCode: number; signal?: number }) => void): {
    dispose(): void;
  };
};

export type SpawnPty = (
  profile: Profile,
  cwd: string,
  cols: number,
  rows: number,
) => PtyProcess;

export type ScreenFactory = (cols: number, rows: number) => TerminalScreen;

export type Session = {
  id: string;
  screen: TerminalScreen;
  status: AgentStatus;
  error: string | null;
  process: PtyProcess | null;
  stopRequested: boolean;
  shutdownSignal: 'SIGHUP' | 'SIGTERM';
  activity: AgentActivity | null;
  threadName: string | null;
  processName: string | null;
};
