/**
 * Projects the model onto one structure canvas: the children of a scope, the
 * outside elements they talk to, and the relations lifted to what is visible.
 */
import type { Element, Model, Relation } from './model.ts';

export interface ProjectedNode {
  element: Element;
  /** inside = a child of the scope; neighbor = outside context. */
  role: 'inside' | 'neighbor';
  childCount: number;
}

export interface ProjectedEdge {
  /** Stable key "<from>-><to>". */
  id: string;
  from: string;
  to: string;
  /** The model relations merged into this thread, in model order. */
  relations: Relation[];
}

export interface Projection {
  scope?: Element;
  /** Root-first chain of the scope's ancestors, ending with the scope itself. */
  breadcrumb: Element[];
  nodes: ProjectedNode[];
  edges: ProjectedEdge[];
}

export function indexById<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/** Root-first ancestors of an element, excluding the element itself. */
export function ancestorsOf(id: string, byId: ReadonlyMap<string, Element>): Element[] {
  const chain: Element[] = [];
  const seen = new Set<string>([id]);
  let current = byId.get(id);
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    chain.unshift(parent);
    current = parent;
  }
  return chain;
}

export function descendantsOf(id: string, elements: readonly Element[]): Element[] {
  const byParent = new Map<string, Element[]>();
  for (const el of elements) {
    if (!el.parentId) continue;
    const list = byParent.get(el.parentId) ?? [];
    list.push(el);
    byParent.set(el.parentId, list);
  }
  const out: Element[] = [];
  const queue = [...(byParent.get(id) ?? [])];
  const seen = new Set<string>([id]);
  while (queue.length) {
    const el = queue.shift()!;
    if (seen.has(el.id)) continue;
    seen.add(el.id);
    out.push(el);
    queue.push(...(byParent.get(el.id) ?? []));
  }
  return out;
}

export function projectStructure(model: Model, scopeId?: string): Projection {
  const byId = indexById(model.elements);
  const scope = scopeId ? byId.get(scopeId) : undefined;
  const scopeAncestors = scope ? ancestorsOf(scope.id, byId) : [];
  const hidden = new Set<string>(scopeAncestors.map((el) => el.id));
  if (scope) hidden.add(scope.id);

  const childCount = new Map<string, number>();
  for (const el of model.elements) {
    if (el.parentId && el.kind !== 'data') childCount.set(el.parentId, (childCount.get(el.parentId) ?? 0) + 1);
  }

  /** The visible node standing in for an element on this canvas, if any. */
  const representative = (id: string): { id: string; role: 'inside' | 'neighbor' } | undefined => {
    const el = byId.get(id);
    if (!el || el.kind === 'data' || hidden.has(id)) return undefined;
    const chain = [...ancestorsOf(id, byId), el];
    if (scope) {
      const at = chain.findIndex((a) => a.id === scope.id);
      if (at >= 0) return { id: chain[at + 1]!.id, role: 'inside' };
      const firstOutside = chain.find((a) => !hidden.has(a.id))!;
      return { id: firstOutside.id, role: 'neighbor' };
    }
    return { id: chain[0]!.id, role: 'inside' };
  };

  const edges = new Map<string, ProjectedEdge>();
  const neighborIds = new Set<string>();
  for (const relation of model.relations) {
    const a = representative(relation.from);
    const b = representative(relation.to);
    if (!a || !b || a.id === b.id) continue;
    if (a.role === 'neighbor' && b.role === 'neighbor') continue;
    if (a.role === 'neighbor') neighborIds.add(a.id);
    if (b.role === 'neighbor') neighborIds.add(b.id);
    const key = `${a.id}->${b.id}`;
    const edge = edges.get(key) ?? { id: key, from: a.id, to: b.id, relations: [] };
    edge.relations.push(relation);
    edges.set(key, edge);
  }

  const nodes: ProjectedNode[] = [];
  for (const el of model.elements) {
    if (el.kind === 'data') continue;
    const inside = scope ? el.parentId === scope.id : !el.parentId || !byId.has(el.parentId);
    if (inside) nodes.push({ element: el, role: 'inside', childCount: childCount.get(el.id) ?? 0 });
    else if (neighborIds.has(el.id)) nodes.push({ element: el, role: 'neighbor', childCount: childCount.get(el.id) ?? 0 });
  }

  return { scope, breadcrumb: scope ? [...scopeAncestors, scope] : [], nodes, edges: [...edges.values()] };
}

/** Ids that stay in full contrast when `selectedIds` are in focus on a projected canvas. */
export function focusSet(projection: Projection, selectedIds: readonly string[]): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set<string>(selectedIds);
  const edges = new Set<string>();
  for (const edge of projection.edges) {
    if (selectedIds.includes(edge.from) || selectedIds.includes(edge.to)) {
      edges.add(edge.id);
      nodes.add(edge.from);
      nodes.add(edge.to);
    }
  }
  return { nodes, edges };
}
