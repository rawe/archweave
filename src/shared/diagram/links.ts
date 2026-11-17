import type { DiagramShape, Model, ModelLink } from '../model.ts';

/** The name of what a link points at, or undefined when it points at nothing. */
export function linkName(model: Pick<Model, 'elements' | 'flows' | 'diagrams'>, link: ModelLink): string | undefined {
  if (link.type === 'element') return model.elements.find((e) => e.id === link.id)?.name;
  if (link.type === 'flow') return model.flows.find((f) => f.id === link.id)?.name;
  return model.diagrams.find((d) => d.id === link.id)?.name;
}

/** What a shape shows as its label: its own text, or the current name of what it links to. */
export function shapeLabel(model: Pick<Model, 'elements' | 'flows' | 'diagrams'>, shape: Pick<DiagramShape, 'text' | 'link'>): string {
  if (shape.text) return shape.text;
  return shape.link ? (linkName(model, shape.link) ?? '') : '';
}
