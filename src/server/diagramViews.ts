import { diagramLints } from '../shared/diagram/lints.ts';
import { linkName, shapeLabel } from '../shared/diagram/links.ts';
import type { Diagram, DiagramConnector, DiagramShape, Model } from '../shared/model.ts';
import { compact, pruned } from './views.ts';

/**
 * The agent-readable form of a diagram: shapes nested in their groups, each with what it shows (`label`),
 * what it links to (with the element's kind and status), the style properties its author set and
 * `at: [x, y, w, h]`; connectors with their set properties; the reading direction, counts and the lints.
 */
export function diagramOutline(model: Model, diagram: Diagram): Record<string, unknown> {
  const children = new Map<string | undefined, DiagramShape[]>();
  const ids = new Set(diagram.shapes.map((s) => s.id));
  for (const s of diagram.shapes) {
    const parent = s.parent && ids.has(s.parent) ? s.parent : undefined;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const nest = (s: DiagramShape): Record<string, unknown> => {
    const inside = children.get(s.id);
    return { ...outlineShape(model, s), ...(inside ? { children: inside.map(nest) } : {}) };
  };
  return {
    ...pruned({
      type: 'diagram',
      id: diagram.id,
      name: diagram.name,
      summary: diagram.summary,
      direction: diagram.direction,
      counts: { shapes: diagram.shapes.length, connectors: diagram.connectors.length },
      shapes: (children.get(undefined) ?? []).map(nest),
      connectors: diagram.connectors.map(outlineConnector),
    }),
    lints: diagramLints(diagram, model),
  };
}

/** One shape without its children: `label` is what it shows, `text` only when its own text hides the linked name. */
export function outlineShape(model: Model, shape: DiagramShape): Record<string, unknown> {
  const label = shapeLabel(model, shape);
  const link = shape.link ? linkName(model, shape.link) : undefined;
  return pruned({
    id: shape.id,
    kind: shape.kind,
    label,
    text: shape.link && shape.text && shape.text !== link ? shape.text : undefined,
    detail: shape.detail,
    link: shape.link ? outlineLink(model, shape.link) : undefined,
    outline: shape.outline,
    tone: shape.tone,
    fill: shape.fill,
    size: shape.size,
    at: [shape.x, shape.y, shape.w, shape.h],
  });
}

export function outlineConnector(connector: DiagramConnector): Record<string, unknown> {
  return pruned({ ...connector });
}

function outlineLink(model: Model, link: NonNullable<DiagramShape['link']>): Record<string, unknown> {
  const name = linkName(model, link);
  if (link.type !== 'element') return pruned({ type: link.type, id: link.id, name, missing: name === undefined || undefined });
  const element = model.elements.find((e) => e.id === link.id);
  return element ? { type: 'element', id: element.id, name: element.name, kind: element.kind, status: element.status } : { type: 'element', id: link.id, missing: true };
}

/**
 * The selected shapes and connectors of the open diagram in full; a selected shape linked to an element
 * carries the element in compact form.
 */
export function diagramSelection(model: Model, diagram: Diagram, ids: string[]): { shapes: Record<string, unknown>[]; connectors: Record<string, unknown>[] } {
  const shapes = new Map(diagram.shapes.map((s) => [s.id, s]));
  const connectors = new Map(diagram.connectors.map((c) => [c.id, c]));
  const out = { shapes: [] as Record<string, unknown>[], connectors: [] as Record<string, unknown>[] };
  for (const id of ids) {
    const shape = shapes.get(id);
    const connector = connectors.get(id);
    if (shape) {
      const element = shape.link?.type === 'element' ? model.elements.find((e) => e.id === shape.link!.id) : undefined;
      out.shapes.push(pruned({ ...outlineShape(model, shape), parent: shape.parent, ...(element ? { link: { type: 'element', ...compact(element) } } : {}) }));
    } else if (connector) out.connectors.push(outlineConnector(connector));
    else out.shapes.push({ id, missing: true });
  }
  return out;
}
