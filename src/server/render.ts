import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import type { Model } from '../shared/model.ts';
import { buildScene, type RenderOptions, renderSvg } from '../shared/diagram/scene.ts';
import { THEMES } from '../shared/diagram/theme.ts';

export interface DiagramImageOptions {
  theme?: 'light' | 'dark';
  background?: RenderOptions['background'];
  padding?: number;
  /** SVG only: embed IBM Plex Sans so the file looks right where the font is not installed. Default true. */
  embedFont?: boolean;
  /** PNG only: pixels per diagram unit, 1 to 4. Default 2. */
  scale?: number;
}

/**
 * Where a file the server needs at run time may be: beside the bundle (`npm start`, Docker), or in
 * the repository when running from source.
 */
const ASSET_DIRS = ['./assets/', '../../assets/', '../../node_modules/@resvg/resvg-wasm/', '../../node_modules/@fontsource-variable/ibm-plex-sans/files/'];

function readAsset(...names: string[]): Buffer {
  for (const dir of ASSET_DIRS) {
    for (const name of names) {
      const file = fileURLToPath(new URL(dir + name, import.meta.url));
      if (fs.existsSync(file)) return fs.readFileSync(file);
    }
  }
  throw new Error(`Missing server asset ${names[0]}`);
}

const RASTER_FONTS = ['fonts/IBMPlexSans-Regular.ttf', 'fonts/IBMPlexSans-Medium.ttf', 'fonts/IBMPlexSans-SemiBold.ttf'];

/** The subsets of the variable web font, with the code points each one covers. */
const WEB_FONTS = [
  {
    file: 'ibm-plex-sans-latin-wght-normal.woff2',
    range: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    always: true,
  },
  {
    file: 'ibm-plex-sans-latin-ext-wght-normal.woff2',
    range: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
    always: false,
  },
];

function inRange(range: string, code: number): boolean {
  return range.split(',').some((part) => {
    const [from, to] = part.slice(2).split('-');
    return code >= parseInt(from!, 16) && code <= parseInt(to ?? from!, 16);
  });
}

const fontFaces = new Map<string, string>();

/** `@font-face` rules carrying the web font as data. The extended subset is only added for text that uses it. */
function fontCss(text: string): string {
  const extended = WEB_FONTS[1]!.range;
  let needsExtended = false;
  for (const char of text) if (inRange(extended, char.codePointAt(0)!)) needsExtended = true;
  return WEB_FONTS.filter((font) => font.always || needsExtended)
    .map((font) => {
      let face = fontFaces.get(font.file);
      if (!face) {
        const data = readAsset(`fonts/${font.file}`, font.file).toString('base64');
        face = `@font-face{font-family:'IBM Plex Sans';font-style:normal;font-weight:100 700;src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${font.range}}`;
        fontFaces.set(font.file, face);
      }
      return face;
    })
    .join('');
}

/** The diagram as a standalone SVG document, or undefined when the model has no such diagram. */
export function renderDiagramSvg(model: Model, diagramId: string, options: DiagramImageOptions = {}): string | undefined {
  const diagram = model.diagrams.find((d) => d.id === diagramId);
  if (!diagram) return undefined;
  const scene = buildScene(diagram, model, THEMES[options.theme ?? 'light']);
  const text = options.embedFont === false ? undefined : [...scene.shapes.flatMap((s) => [s.label, s.shape.detail ?? '']), ...scene.connectors.map((c) => c.connector.label)].join('');
  return renderSvg(scene, { background: options.background, padding: options.padding, ...(text === undefined ? {} : { fontCss: fontCss(text) }) });
}

let rasteriser: Promise<{ fonts: Uint8Array[] }> | undefined;

/** Loads the rasteriser and its fonts on first use; a failure is not remembered, so a later call tries again. */
function loadRasteriser(): Promise<{ fonts: Uint8Array[] }> {
  rasteriser ??= (async () => {
    await initWasm(readAsset('resvg.wasm', 'index_bg.wasm'));
    return { fonts: RASTER_FONTS.map((name) => new Uint8Array(readAsset(name))) };
  })().catch((error: unknown) => {
    rasteriser = undefined;
    throw error;
  });
  return rasteriser;
}

/** The diagram as a PNG image, or undefined when the model has no such diagram. */
export async function renderDiagramPng(model: Model, diagramId: string, options: DiagramImageOptions = {}): Promise<Uint8Array | undefined> {
  const source = renderDiagramSvg(model, diagramId, { ...options, embedFont: false });
  if (source === undefined) return undefined;
  const { fonts } = await loadRasteriser();
  const scale = boundedScale(source, options.scale ?? 2);
  const resvg = new Resvg(source, {
    fitTo: { mode: 'zoom', value: scale },
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' },
  });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}

/** No rendered picture is longer than this on either edge: a diagram with two far-apart shapes must not ask for gigabytes. */
export const MAX_PNG_EDGE = 8192;

/** The requested scale, at most 4, lowered as far as needed to keep the picture within MAX_PNG_EDGE pixels. */
function boundedScale(source: string, wanted: number): number {
  const root = source.slice(0, source.indexOf('>'));
  const size = (name: string) => Number(new RegExp(`\\s${name}="([\\d.]+)"`).exec(root)?.[1] ?? 0);
  const longest = Math.max(size('width'), size('height'), 1);
  return Math.max(0.01, Math.min(4, wanted, MAX_PNG_EDGE / longest));
}
