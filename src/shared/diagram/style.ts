import type { DiagramShape, Fill, Outline, ShapeKind, TextSize, Tone } from '../model.ts';
import type { FontWeight } from './text.ts';
import type { DiagramTheme } from './theme.ts';

/** What a shape of each kind looks like before its author styles it. */
export const KIND_DEFAULTS: Record<ShapeKind, { outline: Outline; tone: Tone; fill: Fill; size: TextSize }> = {
  box: { outline: 'solid', tone: 'neutral', fill: 'plain', size: 'm' },
  pill: { outline: 'solid', tone: 'neutral', fill: 'plain', size: 'm' },
  cylinder: { outline: 'solid', tone: 'neutral', fill: 'plain', size: 'm' },
  diamond: { outline: 'solid', tone: 'neutral', fill: 'plain', size: 'm' },
  actor: { outline: 'solid', tone: 'neutral', fill: 'plain', size: 'm' },
  note: { outline: 'solid', tone: 'amber', fill: 'tint', size: 'm' },
  text: { outline: 'none', tone: 'neutral', fill: 'none', size: 'm' },
  group: { outline: 'solid', tone: 'neutral', fill: 'tint', size: 'm' },
};

export const LABEL_SIZE: Record<TextSize, number> = { s: 12, m: 14, l: 18 };
export const DETAIL_SIZE: Record<TextSize, number> = { s: 11, m: 12, l: 15 };
/** Group titles are a step smaller than labels, so a frame never outweighs what it frames. */
export const GROUP_TITLE_SIZE: Record<TextSize, number> = { s: 12, m: 13, l: 15 };

export const SHAPE_STROKE_WIDTH = 1.25;
export const CONNECTOR_STROKE_WIDTH = 1.5;

/** The type a shape's text is set in. Depends on kind and size only, so sizing can ask without a theme. */
export interface TextStyle {
  labelSize: number;
  labelWeight: FontWeight;
  detailSize: number;
}

export function textStyle(kind: ShapeKind, size: TextSize = KIND_DEFAULTS[kind].size): TextStyle {
  return {
    labelSize: kind === 'group' ? GROUP_TITLE_SIZE[size] : LABEL_SIZE[size],
    labelWeight: kind === 'group' ? 600 : kind === 'note' || kind === 'text' ? 400 : 500,
    detailSize: DETAIL_SIZE[size],
  };
}

export interface StrokePaint {
  stroke: string;
  'stroke-width': number;
  'stroke-dasharray'?: string;
  'stroke-linecap'?: 'round' | 'butt';
  'stroke-linejoin': 'round';
}

/** The stroke attributes of a line style. Dots are round and a little heavier, so they read as dots at 1x. */
export function strokePaint(color: string, line: 'solid' | 'dashed' | 'dotted', width: number): StrokePaint {
  if (line === 'dashed') return { stroke: color, 'stroke-width': width, 'stroke-dasharray': `${width * 4} ${width * 3}`, 'stroke-linecap': 'butt', 'stroke-linejoin': 'round' };
  if (line === 'dotted') return { stroke: color, 'stroke-width': width * 1.2, 'stroke-dasharray': `0.01 ${width * 3.2}`, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  return { stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
}

/** A shape's style with every default resolved to paint. */
export interface ShapeStyle extends TextStyle {
  outline: Outline;
  tone: Tone;
  fill: Fill;
  size: TextSize;
  /** Absent when the outline is `none`. */
  stroke?: StrokePaint;
  /** Absent when the fill is `none`. */
  fillColor?: string;
  fillOpacity?: number;
  /** The tone's outline colour, for details drawn even without an outline (the fold of a note). */
  accent: string;
  ink: string;
  detailInk: string;
}

/** Resolves what the author chose and the defaults of the kind into concrete paint. */
export function shapeStyle(shape: Pick<DiagramShape, 'kind' | 'outline' | 'tone' | 'fill' | 'size'>, theme: DiagramTheme): ShapeStyle {
  const defaults = KIND_DEFAULTS[shape.kind];
  const outline = shape.outline ?? defaults.outline;
  const tone = shape.tone ?? defaults.tone;
  const fill = shape.fill ?? defaults.fill;
  const size = shape.size ?? defaults.size;
  const paint = theme.tones[tone];
  const solid = fill === 'solid';
  const group = shape.kind === 'group';
  const tonedText = group || shape.kind === 'text';
  const style: ShapeStyle = {
    ...textStyle(shape.kind, size),
    outline,
    tone,
    fill,
    size,
    accent: solid ? paint.solid : paint.stroke,
    ink: solid ? theme.onSolid : tonedText ? paint.text : theme.ink,
    detailInk: solid ? theme.onSolid : theme.ink2,
  };
  if (outline !== 'none') style.stroke = strokePaint(solid && outline === 'solid' ? paint.solid : paint.stroke, outline, group ? 1 : SHAPE_STROKE_WIDTH);
  if (fill === 'plain') style.fillColor = theme.surface;
  if (fill === 'solid') style.fillColor = paint.solid;
  if (fill === 'tint') {
    // A group's wash is see-through so nested frames deepen and it works on any background.
    style.fillColor = group ? paint.stroke : paint.tint;
    if (group) style.fillOpacity = theme.name === 'dark' ? 0.09 : 0.07;
  }
  return style;
}
