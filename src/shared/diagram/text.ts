import { ADVANCES, CAP_HEIGHT, FALLBACK_ADVANCE, RUNS, UNITS_PER_EM } from './plexMetrics.ts';

export type FontWeight = 400 | 500 | 600;

/** The family diagram text is set in: the installed or embedded static font first, the app's variable font second. */
export const FONT_FAMILY = "'IBM Plex Sans', 'IBM Plex Sans Variable', system-ui, -apple-system, 'Segoe UI', sans-serif";

let table: Record<FontWeight, Map<number, number>> | undefined;

function advances(weight: FontWeight): Map<number, number> {
  if (!table) {
    table = { 400: new Map(), 500: new Map(), 600: new Map() };
    let index = 0;
    for (const [start, count] of RUNS) {
      for (let i = 0; i < count; i++, index++) {
        for (const w of [400, 500, 600] as const) table[w].set(start + i, ADVANCES[w][index]!);
      }
    }
  }
  return table[weight];
}

/** East Asian scripts, symbols and emoji the font has no glyph for are drawn a full em wide by any fallback font. */
function unknownAdvance(code: number, weight: FontWeight): number {
  if (code < 0x20) return 0;
  return code >= 0x2e80 ? UNITS_PER_EM : FALLBACK_ADVANCE[weight];
}

/** The width of one line of text in IBM Plex Sans, in pixels. Kerning is ignored, which errs on the wide side. */
export function measureText(text: string, size: number, weight: FontWeight = 400): number {
  const known = advances(weight);
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    units += known.get(code) ?? unknownAdvance(code, weight);
  }
  return (units * size) / UNITS_PER_EM;
}

/** The line box of a font size: about 1.36 em, on whole pixels. */
export function lineHeight(size: number): number {
  return Math.round(size * 1.36);
}

/** Distance from the top of a line box to the baseline that centres capital letters in it. */
export function baselineOffset(size: number): number {
  return (lineHeight(size) + (CAP_HEIGHT * size) / UNITS_PER_EM) / 2;
}

/**
 * Breaks text into lines no wider than `maxWidth`. Explicit line breaks are kept, lines break at
 * spaces, and a word wider than a whole line is split between characters. Never returns an empty list.
 */
export function wrapText(text: string, maxWidth: number, size: number, weight: FontWeight = 400): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/[ \t]+/).filter(Boolean)) {
      const joined = line ? `${line} ${word}` : word;
      if (measureText(joined, size, weight) <= maxWidth) {
        line = joined;
        continue;
      }
      if (line) lines.push(line);
      line = word;
      while (measureText(line, size, weight) > maxWidth) {
        const head = fittingPrefix(line, maxWidth, size, weight);
        if (head.length === line.length) break;
        lines.push(head);
        line = line.slice(head.length);
      }
    }
    lines.push(line);
  }
  return lines;
}

/** The longest prefix that fits, at least one character so wrapping always advances. */
function fittingPrefix(word: string, maxWidth: number, size: number, weight: FontWeight): string {
  let prefix = '';
  for (const char of word) {
    if (prefix && measureText(prefix + char, size, weight) > maxWidth) break;
    prefix += char;
  }
  return prefix;
}

/** The width of the widest line. */
export function blockWidth(lines: string[], size: number, weight: FontWeight = 400): number {
  return Math.max(0, ...lines.map((line) => measureText(line, size, weight)));
}
