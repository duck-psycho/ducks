import { measureTextCells } from '@rezi-ui/core';
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map((s) => s.segment);
}

export function cellWidth(text: string): number {
  return measureTextCells(text);
}

export function textWidth(text: string): number {
  return graphemes(text).reduce((sum, g) => sum + cellWidth(g), 0);
}
