/** Copying shapes between and within diagrams: what goes along, and fresh ids on the way in. */
import { z } from 'zod';
import { type Diagram, DiagramConnector, DiagramShape, uniqueId } from '../../shared/model.ts';
import { descendants } from './geometry.ts';

const MARK = 'archweave/shapes';

export const Clip = z.object({ type: z.literal(MARK), shapes: z.array(DiagramShape), connectors: z.array(DiagramConnector) });
export type Clip = z.infer<typeof Clip>;

/**
 * The selected shapes with everything inside the selected groups, and the connectors that run between two
 * copied shapes. A parent that is not copied along is dropped. Undefined when no shape is selected.
 */
export function copyShapes(diagram: Diagram, ids: Iterable<string>): Clip | undefined {
  const picked = new Set(ids);
  const shapeIds = new Set(diagram.shapes.filter((s) => picked.has(s.id)).map((s) => s.id));
  for (const id of descendants(diagram.shapes, shapeIds)) shapeIds.add(id);
  if (!shapeIds.size) return undefined;
  const shapes = diagram.shapes
    .filter((s) => shapeIds.has(s.id))
    .map((s) => {
      if (!s.parent || shapeIds.has(s.parent)) return s;
      const { parent: _, ...rest } = s;
      return rest;
    });
  const connectors = diagram.connectors.filter((c) => shapeIds.has(c.from) && shapeIds.has(c.to));
  return { type: MARK, shapes, connectors };
}

/**
 * The clip as new entries of a diagram whose ids are `taken`: every id made unique, parents and connector
 * ends following their shapes, everything shifted by `offset`.
 */
export function pasteShapes(clip: Clip, taken: Iterable<string>, offset: { x: number; y: number }): { shapes: DiagramShape[]; connectors: DiagramConnector[] } {
  const used = new Set(taken);
  const ids = new Map<string, string>();
  for (const item of [...clip.shapes, ...clip.connectors]) {
    const id = uniqueId(item.id.replace(/-\d+$/, '') || item.id, used);
    used.add(id);
    ids.set(item.id, id);
  }
  const shapes = clip.shapes.map((s) => ({
    ...s,
    id: ids.get(s.id)!,
    x: s.x + offset.x,
    y: s.y + offset.y,
    ...(s.parent ? { parent: ids.get(s.parent) ?? s.parent } : {}),
  }));
  const connectors = clip.connectors.map((c) => ({ ...c, id: ids.get(c.id)!, from: ids.get(c.from)!, to: ids.get(c.to)! }));
  return { shapes, connectors };
}

export function clipText(clip: Clip): string {
  return JSON.stringify(clip);
}

/** A clip read back from clipboard text, or undefined when the text is something else. */
export function parseClip(text: string): Clip | undefined {
  if (!text.includes(MARK)) return undefined;
  try {
    const parsed = Clip.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
