import type { PromptEditor } from '../PromptEditor.js';
import type { ThemeId } from '../themes.js';
export type TreeRow = {
  placeId: string;
  agentId: string | null;
};

export type Menu = {
  kind: 'menu';
  title: string;
  choices: { label: string; action: () => Promise<void> | void }[];
  selected: number;
};

export type Settings = {
  kind: 'settings';
  title: 'Settings';
  theme: ThemeId;
};

export type ShortcutHelp = {
  kind: 'help';
  title: 'Keyboard shortcuts';
  offset: number;
};

export type Prompt = {
  kind: 'prompt';
  title: 'Prompt';
  target: string;
  placeId: string;
  agentId: string;
  editor: PromptEditor;
};

export type Search = {
  kind: 'search';
  title: 'Find place or agent';
  editor: PromptEditor;
  selected: number;
};

export type Modal = Menu | Settings | ShortcutHelp | Prompt | Search;
