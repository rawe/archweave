import type { Element } from '../../shared/model.ts';

/** The structures a field of `structureId` can link to: every other data structure. */
export function fieldLinkTargets(data: Element[], structureId: string): Element[] {
  return data.filter((d) => d.id !== structureId);
}
