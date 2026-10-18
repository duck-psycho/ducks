export const SHORTCUTS = [
  { keys: '', description: 'Commands · Ctrl+B, then within 2 seconds:' },
  { keys: 'p', description: 'Multiline prompt for the selected agent' },
  { keys: 'f', description: 'Find Place or agent by name' },
  { keys: 'a', description: 'New agent in the current Place' },
  { keys: 's', description: 'New Place with a shell' },
  { keys: 'n / b', description: 'Next / previous tab' },
  { keys: '1–9 / 0', description: 'Select tab 1–9 / 10 in the current Place' },
  { keys: 'Enter', description: 'Focus terminal' },
  { keys: 'z', description: 'Close agent (confirm if running)' },
  { keys: 'x', description: 'Close Place (confirm if running)' },
  { keys: 'm', description: 'Settings' },
  { keys: 'q', description: 'Save and quit' },
  { keys: '?', description: 'Show commands' },
  { keys: 'Ctrl+B', description: 'Send literal Ctrl+B to terminal' },
] as const;

export function shortcutVisibleRows(rows: number): number {
  return Math.max(1, Math.min(rows - 9, SHORTCUTS.length));
}
