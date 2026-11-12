/**
 * Text measurement for layouts that must make room for every word. Nothing in
 * the interface is shortened, so boxes are sized from how their text wraps.
 * Uses a canvas in the browser and a character estimate elsewhere (tests).
 */
import { useEffect, useState } from 'react';

export const SANS = `'IBM Plex Sans Variable', 'IBM Plex Sans', system-ui, sans-serif`;
export const MONO = `'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace`;

export interface Measure {
  /** Width of a single line of text. */
  width(text: string, font: string): number;
}

let ctx: CanvasRenderingContext2D | null | undefined;

export const canvasMeasure: Measure = {
  width(text, font) {
    if (ctx === undefined) ctx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (!ctx) return estimateMeasure.width(text, font);
    ctx.font = font;
    return ctx.measureText(text).width;
  },
};

/** A rough measure from the font size alone, for environments without a canvas. */
export const estimateMeasure: Measure = {
  width(text, font) {
    const size = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 13);
    const mono = font.includes('Mono');
    return text.length * size * (mono ? 0.6 : 0.56);
  },
};

/**
 * Lines `text` takes when wrapped at `width`, breaking at spaces and, for words
 * longer than a line, anywhere (as CSS `overflow-wrap: anywhere` does). A few
 * pixels of slack keep the estimate on the safe side of the browser's own wrap.
 */
export function lineCount(text: string, font: string, width: number, measure: Measure = canvasMeasure): number {
  if (!text) return 1;
  const max = Math.max(8, width - 3);
  const space = measure.width(' ', font);
  let lines = 1;
  let used = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let w = measure.width(word, font);
    if (used > 0 && used + space + w <= max) {
      used += space + w;
      continue;
    }
    if (used > 0) lines++;
    used = 0;
    while (w > max) {
      lines++;
      w -= max;
    }
    used = w;
  }
  return lines;
}

/** Bumps once the web fonts have loaded, so measured layouts can be recomputed with the real metrics. */
export function useFontsReady(): number {
  const [version, setVersion] = useState(() => (typeof document !== 'undefined' && document.fonts?.status === 'loaded' ? 1 : 0));
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let alive = true;
    void document.fonts.ready.then(() => alive && setVersion((v) => v + 1));
    const onDone = () => setVersion((v) => v + 1);
    document.fonts.addEventListener?.('loadingdone', onDone);
    return () => {
      alive = false;
      document.fonts.removeEventListener?.('loadingdone', onDone);
    };
  }, []);
  return version;
}
