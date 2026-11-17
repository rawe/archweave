/**
 * Promoting a drawing into the model: a drawn shape becomes an element it then links to, a drawn line
 * between two linked shapes becomes a relation. Always an explicit act; a diagram never adds to the model
 * on its own. Pure, so the browser and the agent guide describe the same operation.
 */
import { type Diagram, type DiagramPatch, type ElementKind, type Model, type RelationKind, type ShapeKind, slugify, type Status, uniqueId } from '../model.ts';

/** The element kind a shape most likely stands for. */
export function promotedKind(kind: ShapeKind): ElementKind {
  switch (kind) {
    case 'cylinder':
      return 'store';
    case 'pill':
      return 'queue';
    case 'actor':
      return 'actor';
    case 'group':
      return 'system';
    default:
      return 'component';
  }
}

export interface ShapePromotion {
  summary: string;
  elements: { id: string; kind: ElementKind; name: string; summary?: string; status: Status }[];
  diagrams: DiagramPatch[];
  elementId: string;
}

/**
 * One change set that creates an element from an unlinked shape and links the shape to it: the name is the
 * first line of the shape's text, the summary its detail, and the shape's text is cleared so it shows the
 * element's live name from then on. Undefined when the shape is missing, linked already or has no text.
 */
export function promoteShape(model: Pick<Model, 'elements'>, diagram: Diagram, shapeId: string, kind: ElementKind): ShapePromotion | undefined {
  const shape = diagram.shapes.find((s) => s.id === shapeId);
  if (!shape || shape.link) return undefined;
  const name = shape.text.split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 120);
  if (!name) return undefined;
  const elementId = uniqueId(slugify(name), new Set(model.elements.map((e) => e.id)));
  const summary = shape.detail?.replace(/\s+/g, ' ').trim().slice(0, 280);
  return {
    summary: `Made ${name} an element`,
    elements: [{ id: elementId, kind, name, ...(summary ? { summary } : {}), status: 'planned' }],
    diagrams: [{ id: diagram.id, setShapes: [{ id: shape.id, text: '', link: { type: 'element', id: elementId } }] }],
    elementId,
  };
}

export interface ConnectorPromotion {
  summary: string;
  relations: { id: string; from: string; to: string; kind: RelationKind; label?: string; status: Status }[];
  relationId: string;
}

/** The elements at the two ends of a connector, when both ends link to elements. */
export function connectorEnds(model: Pick<Model, 'elements'>, diagram: Diagram, connectorId: string): { from: string; to: string } | undefined {
  const connector = diagram.connectors.find((c) => c.id === connectorId);
  if (!connector) return undefined;
  const element = (shapeId: string) => {
    const link = diagram.shapes.find((s) => s.id === shapeId)?.link;
    return link?.type === 'element' && model.elements.some((e) => e.id === link.id) ? link.id : undefined;
  };
  const from = element(connector.from);
  const to = element(connector.to);
  return from && to && from !== to ? { from, to } : undefined;
}

/**
 * A relation for a connector whose two ends link to elements, labelled like the connector. Built when both
 * elements are built, planned otherwise. Undefined when an end is not linked to an element, or when the model
 * relates the two in this direction already.
 */
export function promoteConnector(model: Pick<Model, 'elements' | 'relations'>, diagram: Diagram, connectorId: string): ConnectorPromotion | undefined {
  const ends = connectorEnds(model, diagram, connectorId);
  if (!ends || model.relations.some((r) => r.from === ends.from && r.to === ends.to)) return undefined;
  const connector = diagram.connectors.find((c) => c.id === connectorId)!;
  const kind: RelationKind = 'uses';
  const relationId = uniqueId(slugify(`${ends.from}-${kind}-${ends.to}`), new Set(model.relations.map((r) => r.id)));
  const [a, b] = [ends.from, ends.to].map((id) => model.elements.find((e) => e.id === id)!);
  const label = connector.label.replace(/\s+/g, ' ').trim().slice(0, 80);
  return {
    summary: `Related ${a!.name} to ${b!.name}`,
    relations: [{ id: relationId, from: ends.from, to: ends.to, kind, ...(label ? { label } : {}), status: a!.status === 'built' && b!.status === 'built' ? 'built' : 'planned' }],
    relationId,
  };
}
