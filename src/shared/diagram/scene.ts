import type { Diagram, DiagramConnector, DiagramShape, Model } from '../model.ts';
import { paintConnector, paintConnectorLabel } from './connectors.ts';
import { grownToFit } from './fit.ts';
import { inflate, type Rect, unionRects } from './geometry.ts';
import { shapeLabel } from './links.ts';
import { type ConnectorGeometry, routeConnectors } from './route.ts';
import { paintShape } from './shapes.ts';
import { svg, type SvgNode, toSvgString } from './svg.ts';
import { FONT_FAMILY } from './text.ts';
import type { DiagramTheme } from './theme.ts';

export interface SceneShape {
  /** The stored shape, grown where its text would not have fitted. */
  shape: DiagramShape;
  label: string;
}

export interface SceneConnector {
  connector: DiagramConnector;
  geometry: ConnectorGeometry;
}

/** A diagram resolved for drawing: labels looked up, sizes made to fit, connectors routed, everything in drawing order. */
export interface Scene {
  name: string;
  theme: DiagramTheme;
  shapes: SceneShape[];
  connectors: SceneConnector[];
  /** The box around everything drawn; absent for an empty diagram. */
  bounds?: Rect;
}

/**
 * The order shapes are drawn in: groups first, outer before inner, then everything else as listed.
 * An editor gives its nodes the same stacking.
 */
export function drawingOrder<S extends Pick<DiagramShape, 'id' | 'kind' | 'parent'>>(shapes: S[]): S[] {
  const byId = new Map(shapes.map((s) => [s.id, s]));
  const depth = (shape: S): number => {
    let d = 0;
    for (let at = shape.parent ? byId.get(shape.parent) : undefined; at && d <= shapes.length; at = at.parent ? byId.get(at.parent) : undefined) d++;
    return d;
  };
  const groups = shapes.filter((s) => s.kind === 'group').map((shape, index) => ({ shape, index, depth: depth(shape) }));
  groups.sort((a, b) => a.depth - b.depth || a.index - b.index);
  return [...groups.map((g) => g.shape), ...shapes.filter((s) => s.kind !== 'group')];
}

export function buildScene(diagram: Diagram, model: Pick<Model, 'elements' | 'flows' | 'diagrams'>, theme: DiagramTheme): Scene {
  const shapes = drawingOrder(diagram.shapes).map((stored) => {
    const label = shapeLabel(model, stored);
    return { shape: grownToFit(stored, label), label };
  });
  const routes = routeConnectors(
    shapes.map((s) => s.shape),
    diagram.connectors,
    { direction: diagram.direction },
  );
  const connectors = diagram.connectors.flatMap((connector) => {
    const geometry = routes.get(connector.id);
    return geometry ? [{ connector, geometry }] : [];
  });
  const bounds = unionRects([
    ...shapes.map((s) => s.shape),
    ...connectors.flatMap(({ geometry }) => [pointBounds(geometry), ...(geometry.label ? [geometry.label] : [])]),
  ]);
  return { name: diagram.name, theme, shapes, connectors, ...(bounds ? { bounds } : {}) };
}

function pointBounds(geometry: ConnectorGeometry): Rect {
  const xs = geometry.points.map((p) => p.x);
  const ys = geometry.points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return inflate({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }, 4);
}

/** Paints the whole scene in diagram coordinates: shapes, then lines, then labels. */
export function paintScene(scene: Scene, theme: DiagramTheme = scene.theme): SvgNode[] {
  return [
    ...scene.shapes.map(({ shape, label }) => svg('g', { transform: `translate(${shape.x} ${shape.y})` }, paintShape(shape, label, theme))),
    ...scene.connectors.flatMap(({ connector, geometry }) => paintConnector(geometry, connector, theme)),
    ...scene.connectors.flatMap(({ geometry }) => paintConnectorLabel(geometry, theme)),
  ];
}

export interface RenderOptions {
  /** `canvas` is the app's canvas colour of the theme. Default `canvas`. */
  background?: 'canvas' | 'white' | 'transparent';
  /** Air around the content, in diagram units. Default 32. */
  padding?: number;
  /** CSS placed in a `<style>` element, meant for the `@font-face` rules that make the file self-contained. */
  fontCss?: string;
}

/** A standalone SVG document of the scene, sized to its content plus padding. */
export function renderSvg(scene: Scene, options: RenderOptions = {}): string {
  const background = options.background ?? 'canvas';
  const padding = options.padding ?? 32;
  const content = scene.bounds ?? { x: 0, y: 0, w: 240, h: 120 };
  const x = Math.floor(content.x - padding);
  const y = Math.floor(content.y - padding);
  const w = Math.ceil(content.x + content.w + padding) - x;
  const h = Math.ceil(content.y + content.h + padding) - y;
  // Connector labels sit on a patch of whatever is behind them.
  const theme: DiagramTheme = background === 'white' ? { ...scene.theme, canvas: '#ffffff' } : scene.theme;
  const children: SvgNode[] = [svg('title', {}, scene.name)];
  if (options.fontCss) children.push(svg('style', {}, options.fontCss));
  if (background !== 'transparent') children.push(svg('rect', { x, y, width: w, height: h, fill: theme.canvas }));
  children.push(...paintScene(scene, theme));
  return toSvgString(
    svg('svg', { xmlns: 'http://www.w3.org/2000/svg', width: w, height: h, viewBox: `${x} ${y} ${w} ${h}`, 'font-family': FONT_FAMILY, 'text-rendering': 'geometricPrecision' }, children),
  );
}
