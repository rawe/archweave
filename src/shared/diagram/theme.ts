import type { Tone } from '../model.ts';

/** The colours one tone paints with. */
export interface TonePaint {
  /** Outlines of shapes. */
  stroke: string;
  /** Connector lines and arrowheads. */
  line: string;
  /** The soft wash of fill `tint`; ink and secondary ink stay readable on it. */
  tint: string;
  /** The fill of `solid`; `onSolid` text is readable on it. */
  solid: string;
  /** Toned text on the canvas, the surface or the tint: free text and group titles. */
  text: string;
}

/** Everything the renderer needs to know about colour. Diagrams store tones, never colours. */
export interface DiagramTheme {
  name: 'light' | 'dark';
  /** The app's `--canvas`: export background and the patch behind connector labels. */
  canvas: string;
  /** The app's `--surface`: fill `plain`. */
  surface: string;
  ink: string;
  ink2: string;
  onSolid: string;
  tones: Record<Tone, TonePaint>;
}

/**
 * The diagram blue leans to steel and the amber to ochre, so neither is mistaken for the cobalt of the
 * human's selection or the saffron of agent activity in the app chrome.
 */
export const LIGHT_THEME: DiagramTheme = {
  name: 'light',
  canvas: '#edf0f3',
  surface: '#ffffff',
  ink: '#17202b',
  ink2: '#5b6878',
  onSolid: '#ffffff',
  tones: {
    neutral: { stroke: '#8a95a3', line: '#6d7887', tint: '#e2e6eb', solid: '#4d5969', text: '#17202b' },
    blue: { stroke: '#4d86c6', line: '#4d86c6', tint: '#e2edf9', solid: '#2f6db1', text: '#245a96' },
    teal: { stroke: '#2e9c97', line: '#2e9c97', tint: '#dbf1ef', solid: '#177a76', text: '#12645f' },
    green: { stroke: '#4f9f62', line: '#4f9f62', tint: '#e0f2e4', solid: '#2f7d46', text: '#27683a' },
    amber: { stroke: '#c98a35', line: '#c98a35', tint: '#faefd9', solid: '#a1600f', text: '#8a520c' },
    red: { stroke: '#d0635d', line: '#d0635d', tint: '#fbe8e6', solid: '#b6423d', text: '#9c3632' },
    violet: { stroke: '#8a72cf', line: '#8a72cf', tint: '#ede9fa', solid: '#6a51b6', text: '#58419c' },
  },
};

export const DARK_THEME: DiagramTheme = {
  name: 'dark',
  canvas: '#12161c',
  surface: '#1b212a',
  ink: '#e8ecf1',
  ink2: '#98a4b3',
  onSolid: '#ffffff',
  tones: {
    neutral: { stroke: '#707c8b', line: '#8793a3', tint: '#262d38', solid: '#566272', text: '#e8ecf1' },
    blue: { stroke: '#5f9ade', line: '#5f9ade', tint: '#1e3048', solid: '#2f6db1', text: '#8dbaf0' },
    teal: { stroke: '#3fb0aa', line: '#3fb0aa', tint: '#17363a', solid: '#177a76', text: '#6fd0c9' },
    green: { stroke: '#5fb274', line: '#5fb274', tint: '#1c3626', solid: '#2f7d46', text: '#86cf98' },
    amber: { stroke: '#d6a04e', line: '#d6a04e', tint: '#3a2e1b', solid: '#a1600f', text: '#e6bb74' },
    red: { stroke: '#e27770', line: '#e27770', tint: '#3e2526', solid: '#b6423d', text: '#f0a09a' },
    violet: { stroke: '#a08be3', line: '#a08be3', tint: '#2d2848', solid: '#6a51b6', text: '#bcabf2' },
  },
};

export const THEMES: Record<DiagramTheme['name'], DiagramTheme> = { light: LIGHT_THEME, dark: DARK_THEME };

/** WCAG 2 contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function luminance(hex: string): number {
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
