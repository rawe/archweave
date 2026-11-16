import type { DiagramShape, ShapeKind, TextSize } from '../model.ts';
import { KIND_MIN, layoutShape, minHeightAt, textFrame } from './layout.ts';
import { textStyle } from './style.ts';
import { blockWidth, wrapText } from './text.ts';

export interface FitInput {
  kind: ShapeKind;
  /** The label as shown (see `shapeLabel`). */
  label: string;
  detail?: string;
  size?: TextSize;
}

const GRID = 8;

/** The size a shape starts from when its text is short. */
const COMFORTABLE: Record<ShapeKind, { w: number; h: number }> = {
  box: { w: 112, h: 48 },
  pill: { w: 96, h: 40 },
  cylinder: { w: 112, h: 72 },
  diamond: { w: 104, h: 72 },
  actor: { w: 72, h: 64 },
  note: { w: 120, h: 40 },
  text: { w: 32, h: 24 },
  group: { w: 320, h: 200 },
};

/** The line length text is wrapped to when nobody chose a width. Prose kinds get longer lines than labels. */
function comfortableLine(kind: ShapeKind, size: TextSize): number {
  const label = size === 's' ? 140 : size === 'l' ? 216 : 168;
  return kind === 'note' || kind === 'text' || kind === 'group' ? label * 1.4 : label;
}

/**
 * The size a shape takes when its author gave none: wide enough for its text at a comfortable
 * line length, tall enough for every line, on the 8-unit grid.
 */
export function fitShape(input: FitInput): { w: number; h: number } {
  const { kind } = input;
  const size = input.size ?? 'm';
  const type = textStyle(kind, size);
  const line = comfortableLine(kind, size);
  const start = COMFORTABLE[kind];
  const textWidth = Math.max(
    input.label.trim() ? blockWidth(wrapText(input.label, line, type.labelSize, type.labelWeight), type.labelSize, type.labelWeight) : 0,
    input.detail?.trim() ? blockWidth(wrapText(input.detail, line, type.detailSize, 400), type.detailSize, 400) : 0,
  );
  let w = start.w;
  for (; w < 960; w += GRID) {
    const frame = textFrame(kind, w, start.h, size);
    if (frame.right - frame.left >= textWidth + 0.5) break;
  }
  // Rounded up to the grid and checked again: a pill's frame narrows as it gets taller.
  let h = start.h;
  for (let fitting = minHeightAt(input, w, h); fitting > h; fitting = minHeightAt(input, w, h)) h = Math.ceil(fitting / GRID) * GRID;
  return { w, h };
}

/**
 * The smallest size a shape may be resized to: `w` is the least width of its kind, `h` the least height
 * at which all of its text fits at the shape's current width (narrower means more lines, so taller).
 * An editor clamps the width first, then asks again with that width and clamps the height.
 */
export function minSize(shape: Pick<DiagramShape, 'kind' | 'w' | 'detail' | 'size'>, label: string): { w: number; h: number } {
  const min = KIND_MIN[shape.kind];
  const w = Math.max(min.w, shape.w);
  return { w: min.w, h: minHeightAt({ kind: shape.kind, label, detail: shape.detail, size: shape.size }, w) };
}

/**
 * The shape grown, from its top-left corner, until it holds its text: first out to the width it would
 * have been given by `fitShape`, then down. Unchanged when the text already fits.
 */
export function grownToFit<S extends Pick<DiagramShape, 'kind' | 'w' | 'h' | 'detail' | 'size'>>(shape: S, label: string): S {
  const min = KIND_MIN[shape.kind];
  const text = { kind: shape.kind, label, detail: shape.detail, size: shape.size };
  if (shape.w >= min.w && shape.h >= min.h && layoutShape({ ...text, w: shape.w, h: shape.h }).fits) return shape;
  const w = Math.max(shape.w, shape.kind === 'group' ? min.w : fitShape(text).w);
  return { ...shape, w, h: minHeightAt(text, w, shape.h) };
}
