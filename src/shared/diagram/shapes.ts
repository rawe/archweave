import type { DiagramShape } from '../model.ts';
import { roundedPath } from './geometry.ts';
import { actorFigure, BOX_RADIUS, cylinderRy, GROUP_RADIUS, layoutShape, NOTE_FOLD } from './layout.ts';
import { type ShapeStyle, shapeStyle } from './style.ts';
import { num, svg, type SvgNode } from './svg.ts';
import type { DiagramTheme } from './theme.ts';

export type PaintableShape = Pick<DiagramShape, 'kind' | 'w' | 'h' | 'detail' | 'outline' | 'tone' | 'fill' | 'size'>;

/**
 * Paints one shape in its own coordinates, the origin at its top-left corner. The result depends on
 * nothing but size, style and text, so an editor repaints only the shape being resized or restyled.
 * The outline is drawn inside the box, never straddling its edge.
 */
export function paintShape(shape: PaintableShape, label: string, theme: DiagramTheme): SvgNode[] {
  const style = shapeStyle(shape, theme);
  const layout = layoutShape({ kind: shape.kind, label, detail: shape.detail, size: shape.size, w: shape.w, h: shape.h });
  const nodes = outline(shape, style, layout.figureTop ?? 0);
  for (const line of layout.lines) {
    nodes.push(
      svg(
        'text',
        {
          x: line.x,
          y: line.y,
          'text-anchor': line.anchor === 'middle' ? 'middle' : undefined,
          'font-size': line.size,
          'font-weight': line.weight,
          fill: line.role === 'label' ? style.ink : style.detailInk,
        },
        line.text,
      ),
    );
  }
  return nodes;
}

function surface(style: ShapeStyle): Record<string, string | number | undefined> {
  return { fill: style.fillColor ?? 'none', 'fill-opacity': style.fillOpacity, ...(style.stroke ?? {}) };
}

function outline(shape: PaintableShape, style: ShapeStyle, figureTop: number): SvgNode[] {
  const { w, h } = shape;
  const i = style.stroke ? style.stroke['stroke-width'] / 2 : 0;
  if (!style.stroke && !style.fillColor && shape.kind !== 'note' && shape.kind !== 'actor') return [];
  const paint = surface(style);
  const rect = (radius: number): SvgNode => svg('rect', { x: i, y: i, width: w - 2 * i, height: h - 2 * i, rx: Math.max(0, Math.min(radius, w / 2, h / 2) - i), ...paint });

  switch (shape.kind) {
    case 'pill':
      return [rect(Math.min(w, h) / 2)];
    case 'group':
      return [rect(GROUP_RADIUS)];
    case 'text':
      return [rect(6)];
    case 'diamond':
      return [
        svg('path', {
          d: roundedPath(
            [
              { x: w / 2, y: i },
              { x: w - i, y: h / 2 },
              { x: w / 2, y: h - i },
              { x: i, y: h / 2 },
            ],
            5,
            true,
          ),
          ...paint,
        }),
      ];
    case 'cylinder': {
      const rx = w / 2 - i;
      const ry = cylinderRy(w);
      const top = i + ry;
      const bottom = h - i - ry;
      return [
        svg('path', {
          d: `M${num(i)},${num(top)}A${num(rx)},${num(ry)} 0 0 1 ${num(w - i)},${num(top)}V${num(bottom)}A${num(rx)},${num(ry)} 0 0 1 ${num(i)},${num(bottom)}Z`,
          ...paint,
        }),
        svg('path', { d: `M${num(i)},${num(top)}A${num(rx)},${num(ry)} 0 0 0 ${num(w - i)},${num(top)}`, ...paint, fill: 'none', 'fill-opacity': undefined }),
      ];
    }
    case 'note': {
      const f = Math.min(NOTE_FOLD, w / 3, h / 3);
      const r = 3;
      const d =
        `M${num(i + r)},${num(i)}H${num(w - i - f)}L${num(w - i)},${num(i + f)}V${num(h - i - r)}` +
        `Q${num(w - i)},${num(h - i)} ${num(w - i - r)},${num(h - i)}H${num(i + r)}Q${num(i)},${num(h - i)} ${num(i)},${num(h - i - r)}` +
        `V${num(i + r)}Q${num(i)},${num(i)} ${num(i + r)},${num(i)}Z`;
      const fold = `M${num(w - i - f)},${num(i)}V${num(i + f - 2)}Q${num(w - i - f)},${num(i + f)} ${num(w - i - f + 2)},${num(i + f)}H${num(w - i)}Z`;
      return [
        svg('path', { d, ...paint }),
        svg('path', { d: fold, fill: style.accent, 'fill-opacity': style.fill === 'solid' ? 0 : 0.22, ...(style.stroke ?? {}), 'stroke-dasharray': undefined }),
      ];
    }
    case 'actor': {
      const figure = actorFigure(style.size);
      const s = figure / 36;
      const cx = w / 2;
      const y = figureTop;
      const head = 6.5 * s;
      const shoulders = 14 * s;
      const neck = y + 2 * head + 4.5 * s;
      const base = y + figure - i;
      const body =
        `M${num(cx - shoulders)},${num(base)}` +
        `C${num(cx - shoulders)},${num(neck + 3 * s)} ${num(cx - 7 * s)},${num(neck)} ${num(cx)},${num(neck)}` +
        `C${num(cx + 7 * s)},${num(neck)} ${num(cx + shoulders)},${num(neck + 3 * s)} ${num(cx + shoulders)},${num(base)}Z`;
      // A person with neither outline nor fill would be invisible, so the figure is then drawn as a silhouette.
      const figurePaint = style.stroke || style.fillColor ? paint : { fill: style.accent };
      return [svg('circle', { cx, cy: y + head + i, r: head, ...figurePaint }), svg('path', { d: body, ...figurePaint })];
    }
    default:
      return [rect(BOX_RADIUS)];
  }
}
