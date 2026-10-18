import { defined } from './defined.js';

export type ThemeColors = {
  bg: number;
  sidebar: number;
  fg: number;
  muted: number;
  line: number;
  accent: number;
  selected: number;
  green: number;
  red: number;
  yellow: number;
};

export type Theme = {
  id: string;
  name: string;
  appearance: 'Dark' | 'Light';
  colors: ThemeColors;
  ansi: ReadonlyArray<number>;
};

// Adapted from the palettes maintained by each theme's authors:
// https://github.com/catppuccin/palette
// https://github.com/dracula/visual-studio-code
// https://github.com/nordtheme/nord
// https://github.com/primer/github-vscode-theme
// https://github.com/altercation/solarized
export const THEMES: ReadonlyArray<Theme & { id: ThemeId }> = [
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    appearance: 'Dark',
    colors: {
      bg: 0x11111b,
      sidebar: 0x181825,
      fg: 0xcdd6f4,
      muted: 0x7f849c,
      line: 0x313244,
      accent: 0x89b4fa,
      selected: 0x313c58,
      green: 0xa6e3a1,
      red: 0xf38ba8,
      yellow: 0xf9e2af,
    },
    ansi: [
      0x1e1e2e, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xcba6f7, 0x94e2d5,
      0xbac2de, 0x585b70, 0xf38ba8, 0xa6e3a1, 0xf9e2af, 0x89b4fa, 0xcba6f7,
      0x94e2d5, 0xa6adc8,
    ],
  },
  {
    id: 'dracula',
    name: 'Dracula',
    appearance: 'Dark',
    colors: {
      bg: 0x282a36,
      sidebar: 0x21222c,
      fg: 0xf8f8f2,
      muted: 0x9099bd,
      line: 0x44475a,
      accent: 0xbd93f9,
      selected: 0x44475a,
      green: 0x50fa7b,
      red: 0xff5555,
      yellow: 0xf1fa8c,
    },
    ansi: [
      0x21222c, 0xff5555, 0x50fa7b, 0xf1fa8c, 0xbd93f9, 0xff79c6, 0x8be9fd,
      0xf8f8f2, 0x6272a4, 0xff6e6e, 0x69ff94, 0xffffa5, 0xd6acff, 0xff92df,
      0xa4ffff, 0xffffff,
    ],
  },
  {
    id: 'nord',
    name: 'Nord',
    appearance: 'Dark',
    colors: {
      bg: 0x2e3440,
      sidebar: 0x3b4252,
      fg: 0xeceff4,
      muted: 0xa6afc1,
      line: 0x4c566a,
      accent: 0x88c0d0,
      selected: 0x434c5e,
      green: 0xa3be8c,
      red: 0xbf616a,
      yellow: 0xebcb8b,
    },
    ansi: [
      0x3b4252, 0xbf616a, 0xa3be8c, 0xebcb8b, 0x81a1c1, 0xb48ead, 0x88c0d0,
      0xe5e9f0, 0x4c566a, 0xbf616a, 0xa3be8c, 0xebcb8b, 0x81a1c1, 0xb48ead,
      0x8fbcbb, 0xeceff4,
    ],
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    appearance: 'Light',
    colors: {
      bg: 0xeff1f5,
      sidebar: 0xe6e9ef,
      fg: 0x4c4f69,
      muted: 0x6c6f85,
      line: 0xccd0da,
      accent: 0x1e66f5,
      selected: 0xccd0da,
      green: 0x40a02b,
      red: 0xd20f39,
      yellow: 0x9c650e,
    },
    ansi: [
      0x5c5f77, 0xd20f39, 0x40a02b, 0xdf8e1d, 0x1e66f5, 0x8839ef, 0x179299,
      0xacb0be, 0x6c6f85, 0xd20f39, 0x40a02b, 0xdf8e1d, 0x1e66f5, 0x8839ef,
      0x179299, 0xbcc0cc,
    ],
  },
  {
    id: 'github-light',
    name: 'GitHub Light',
    appearance: 'Light',
    colors: {
      bg: 0xffffff,
      sidebar: 0xf6f8fa,
      fg: 0x24292f,
      muted: 0x57606a,
      line: 0xd0d7de,
      accent: 0x0969da,
      selected: 0xddf4ff,
      green: 0x1a7f37,
      red: 0xcf222e,
      yellow: 0x9a6700,
    },
    ansi: [
      0x24292f, 0xcf222e, 0x116329, 0x4d2d00, 0x0969da, 0x8250df, 0x1b7c83,
      0x6e7781, 0x57606a, 0xa40e26, 0x1a7f37, 0x633c01, 0x218bff, 0xa475f9,
      0x3192aa, 0x8c959f,
    ],
  },
  {
    id: 'solarized-light',
    name: 'Solarized Light',
    appearance: 'Light',
    colors: {
      bg: 0xfdf6e3,
      sidebar: 0xeee8d5,
      fg: 0x657b83,
      muted: 0x586e75,
      line: 0x93a1a1,
      accent: 0x268bd2,
      selected: 0xe2ddc8,
      green: 0x6d7d00,
      red: 0xdc322f,
      yellow: 0x977200,
    },
    ansi: [
      0x073642, 0xdc322f, 0x859900, 0xb58900, 0x268bd2, 0xd33682, 0x2aa198,
      0xeee8d5, 0x002b36, 0xcb4b16, 0x586e75, 0x657b83, 0x839496, 0x6c71c4,
      0x93a1a1, 0xfdf6e3,
    ],
  },
];

export type ThemeId =
  | 'catppuccin-mocha'
  | 'dracula'
  | 'nord'
  | 'catppuccin-latte'
  | 'github-light'
  | 'solarized-light';

export const DEFAULT_THEME: Theme & { id: ThemeId } = defined(THEMES[0]);
export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

export function getTheme(id: ThemeId): Theme {
  return THEMES.find((theme) => theme.id === id) ?? DEFAULT_THEME;
}
