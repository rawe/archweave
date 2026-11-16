import type { ShapeKind, TextSize } from '../model.ts';
import { textStyle } from './style.ts';
import { baselineOffset, blockWidth, type FontWeight, lineHeight, wrapText } from './text.ts';

/** The part of a shape its text may occupy, in the shape's own coordinates. */
export interface TextFrame {
  left: number;
  right: number;
  top: number;
  bottom: number;
  align: 'start' | 'middle';
  valign: 'top' | 'middle';
}

export interface TextLine {
  text: string;
  role: 'label' | 'detail';
  x: number;
  /** The baseline. */
  y: number;
  anchor: 'start' | 'middle';
  size: number;
  weight: FontWeight;
}

export interface ShapeLayout {
  lines: TextLine[];
  /** Height of the whole text block. */
  textHeight: number;
  /** Width of its widest line. */
  textWidth: number;
  /** False when the block is taller than the frame; `minSize` gives a size where it is true. */
  fits: boolean;
  /** Actor only: top of the figure, which sits centred above the text. */
  figureTop?: number;
}

export const BOX_RADIUS = 10;
export const GROUP_RADIUS = 14;
export const NOTE_FOLD = 12;
const ACTOR_GAP = 6;

/** Height of the person figure of an actor. */
export function actorFigure(size: TextSize = 'm'): number {
  return size === 's' ? 30 : size === 'l' ? 44 : 36;
}

/** Vertical radius of the ellipses of a cylinder: flat, and flatter in proportion as the shape widens. */
export function cylinderRy(w: number): number {
  return Math.max(5, Math.min(10, w * 0.07));
}

/** The smallest size the editor lets a shape of each kind take, whatever its text. */
export const KIND_MIN: Record<ShapeKind, { w: number; h: number }> = {
  box: { w: 56, h: 32 },
  pill: { w: 64, h: 28 },
  cylinder: { w: 64, h: 48 },
  diamond: { w: 80, h: 48 },
  actor: { w: 48, h: 40 },
  note: { w: 64, h: 32 },
  text: { w: 24, h: 20 },
  group: { w: 96, h: 56 },
};

export function textFrame(kind: ShapeKind, w: number, h: number, size: TextSize = 'm'): TextFrame {
  switch (kind) {
    case 'pill': {
      const r = Math.min(w, h) / 2;
      const along = Math.max(14, r * 0.6);
      return w >= h
        ? { left: along, right: w - along, top: 7, bottom: h - 7, align: 'middle', valign: 'middle' }
        : { left: 12, right: w - 12, top: Math.max(10, along), bottom: h - Math.max(10, along), align: 'middle', valign: 'middle' };
    }
    case 'cylinder': {
      const ry = cylinderRy(w);
      return { left: 14, right: w - 14, top: 2 * ry + 5, bottom: h - ry * 0.5 - 6, align: 'middle', valign: 'middle' };
    }
    case 'diamond': {
      // A centred rectangle spanning 56% of the width and 34% of the height keeps its corners clear of the edges.
      const fw = w * 0.56;
      const fh = h * 0.34;
      return { left: (w - fw) / 2, right: (w + fw) / 2, top: (h - fh) / 2, bottom: (h + fh) / 2, align: 'middle', valign: 'middle' };
    }
    case 'actor':
      return { left: 4, right: w - 4, top: 2 + actorFigure(size) + ACTOR_GAP, bottom: h - 2, align: 'middle', valign: 'middle' };
    case 'note':
      return { left: 12, right: w - 12, top: 10, bottom: h - 10, align: 'start', valign: 'top' };
    case 'text':
      return { left: 6, right: w - 6, top: 4, bottom: h - 4, align: 'start', valign: 'middle' };
    case 'group':
      return { left: 14, right: w - 14, top: 11, bottom: h - 11, align: 'start', valign: 'top' };
    default:
      return { left: 14, right: w - 14, top: 9, bottom: h - 9, align: 'middle', valign: 'middle' };
  }
}

export interface TextInput {
  kind: ShapeKind;
  label: string;
  detail?: string;
  size?: TextSize;
}

/** Wraps a shape's label and detail into its frame and places every line. */
export function layoutShape(input: TextInput & { w: number; h: number }): ShapeLayout {
  const { kind, w, h } = input;
  const type = textStyle(kind, input.size);
  const frame = textFrame(kind, w, h, input.size);
  const width = Math.max(1, frame.right - frame.left);
  const labelLines = input.label.trim() ? wrapText(input.label, width, type.labelSize, type.labelWeight) : [];
  const detailLines = input.detail?.trim() ? wrapText(input.detail, width, type.detailSize, 400) : [];
  const labelLh = lineHeight(type.labelSize);
  const detailLh = lineHeight(type.detailSize);
  const gap = labelLines.length && detailLines.length ? Math.round(type.labelSize * 0.25) : 0;
  const textHeight = labelLines.length * labelLh + gap + detailLines.length * detailLh;
  const available = frame.bottom - frame.top;

  let top = frame.valign === 'top' ? frame.top : frame.top + (available - textHeight) / 2;
  let figureTop: number | undefined;
  if (kind === 'actor') {
    const figure = actorFigure(input.size);
    const column = figure + (textHeight ? ACTOR_GAP + textHeight : 0);
    figureTop = Math.max(2, (h - column) / 2);
    top = figureTop + figure + ACTOR_GAP;
  }

  const x = frame.align === 'middle' ? (frame.left + frame.right) / 2 : frame.left;
  const lines: TextLine[] = [];
  let y = top;
  for (const text of labelLines) {
    lines.push({ text, role: 'label', x, y: y + baselineOffset(type.labelSize), anchor: frame.align, size: type.labelSize, weight: type.labelWeight });
    y += labelLh;
  }
  y += gap;
  for (const text of detailLines) {
    lines.push({ text, role: 'detail', x, y: y + baselineOffset(type.detailSize), anchor: frame.align, size: type.detailSize, weight: 400 });
    y += detailLh;
  }
  return {
    lines,
    textHeight,
    textWidth: Math.max(blockWidth(labelLines, type.labelSize, type.labelWeight), blockWidth(detailLines, type.detailSize, 400)),
    fits: textHeight <= available + 0.01,
    ...(figureTop === undefined ? {} : { figureTop }),
  };
}

/** The least height, not below `from`, at which the text of a shape of width `w` fits its frame. */
export function minHeightAt(input: TextInput, w: number, from = 0): number {
  let h = Math.max(from, KIND_MIN[input.kind].h);
  for (let i = 0; i < 400; i++) {
    const frame = textFrame(input.kind, w, h, input.size);
    const layout = layoutShape({ ...input, w, h });
    const missing = layout.textHeight - (frame.bottom - frame.top);
    if (missing <= 0.01) break;
    h += Math.max(1, Math.ceil(missing));
  }
  return h;
}
