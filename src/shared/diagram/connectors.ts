import type { DiagramConnector } from '../model.ts';
import { ARROW_LENGTH, CONNECTOR_LABEL_SIZE, type ArrowHead, type ConnectorGeometry } from './route.ts';
import { CONNECTOR_STROKE_WIDTH, strokePaint } from './style.ts';
import { num, svg, type SvgNode } from './svg.ts';
import { baselineOffset, lineHeight } from './text.ts';
import type { DiagramTheme } from './theme.ts';

export type PaintableConnector = Partial<Pick<DiagramConnector, 'line' | 'tone'>>;

const ARROW_HALF_WIDTH = 3.6;

/** Paints the line and arrowheads of a routed connector, in diagram coordinates. The label is a layer of its own. */
export function paintConnector(geometry: ConnectorGeometry, connector: PaintableConnector, theme: DiagramTheme): SvgNode[] {
  const color = theme.tones[connector.tone ?? 'neutral'].line;
  return [
    svg('path', { d: geometry.path, fill: 'none', ...strokePaint(color, connector.line ?? 'solid', CONNECTOR_STROKE_WIDTH) }),
    ...geometry.heads.map((head) => svg('path', { d: arrowPath(head), fill: color, stroke: color, 'stroke-width': 0.8, 'stroke-linejoin': 'round' })),
  ];
}

/** A slim triangle with a notched back, so the head reads as an arrow and not as a wedge. */
function arrowPath({ tip, dx, dy }: ArrowHead): string {
  const at = (back: number, side: number): string => `${num(tip.x - dx * back - dy * side)},${num(tip.y - dy * back + dx * side)}`;
  return `M${at(0.4, 0)}L${at(ARROW_LENGTH, ARROW_HALF_WIDTH)}L${at(ARROW_LENGTH - 2.2, 0)}L${at(ARROW_LENGTH, -ARROW_HALF_WIDTH)}Z`;
}

/**
 * Paints a connector's label over a patch of the canvas colour, so the line does not strike through
 * the words. Empty when the connector has no label.
 */
export function paintConnectorLabel(geometry: ConnectorGeometry, theme: DiagramTheme): SvgNode[] {
  const label = geometry.label;
  if (!label) return [];
  const leading = lineHeight(CONNECTOR_LABEL_SIZE);
  const top = label.y + (label.h - label.lines.length * leading) / 2;
  return [
    svg('rect', { x: label.x, y: label.y, width: label.w, height: label.h, rx: 4, fill: theme.canvas }),
    ...label.lines.map((line, i) =>
      svg(
        'text',
        { x: label.x + label.w / 2, y: top + i * leading + baselineOffset(CONNECTOR_LABEL_SIZE), 'text-anchor': 'middle', 'font-size': CONNECTOR_LABEL_SIZE, 'font-weight': 400, fill: theme.ink2 },
        line,
      ),
    ),
  ];
}
