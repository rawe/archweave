import type { Element } from '../../shared/model.ts';
import { fuzzyScore } from '../lib/fuzzy.ts';
import { scopePath, type ModelIndex } from '../state/selectors.ts';

export interface StructureGroup {
  /** Owner element id, or '' for structures without an owner. */
  owner: string;
  name: string;
  /** Where the owner lives, for a tooltip. */
  path: string;
  items: Element[];
}

/**
 * Data structures grouped by the element that owns them, as the rail and the
 * catalog list them: structures without an owner first, then owners by name,
 * structures by name inside each group. `filter` matches names and field names.
 */
export function groupStructures(index: ModelIndex, filter = ''): StructureGroup[] {
  const q = filter.trim();
  const list = index.data.filter((d) => !q || fuzzyScore(q, `${d.name} ${d.fields.map((f) => f.name).join(' ')}`) >= 0);
  const byOwner = new Map<string, Element[]>();
  for (const d of list) {
    const owner = d.parentId && index.byId.get(d.parentId) ? d.parentId : '';
    (byOwner.get(owner) ?? byOwner.set(owner, []).get(owner)!).push(d);
  }
  return [...byOwner.entries()]
    .map(([owner, items]) => {
      const el = owner ? index.byId.get(owner)! : undefined;
      return {
        owner,
        name: el ? el.name : 'Shared',
        path: el ? [scopePath(el, index), el.name].filter(Boolean).join(' › ') : 'Not owned by any element',
        items: items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
      };
    })
    .sort((a, b) => (a.owner ? 1 : 0) - (b.owner ? 1 : 0) || a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner));
}
