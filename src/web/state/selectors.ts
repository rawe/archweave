import { useMemo } from 'react';
import type { Element, Model, Relation } from '../../shared/model.ts';
import { useStore } from './store.ts';

export interface ModelIndex {
  byId: Map<string, Element>;
  relById: Map<string, Relation>;
  out: Map<string, Relation[]>;
  in: Map<string, Relation[]>;
  children: Map<string, Element[]>;
  data: Element[];
}

export function buildIndex(model: Model): ModelIndex {
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const relById = new Map(model.relations.map((r) => [r.id, r]));
  const out = new Map<string, Relation[]>();
  const inn = new Map<string, Relation[]>();
  for (const r of model.relations) {
    (out.get(r.from) ?? out.set(r.from, []).get(r.from)!).push(r);
    (inn.get(r.to) ?? inn.set(r.to, []).get(r.to)!).push(r);
  }
  const children = new Map<string, Element[]>();
  for (const e of model.elements) if (e.parentId) (children.get(e.parentId) ?? children.set(e.parentId, []).get(e.parentId)!).push(e);
  return { byId, relById, out, in: inn, children, data: model.elements.filter((e) => e.kind === 'data') };
}

export function useIndex(): ModelIndex {
  const model = useStore((s) => s.model);
  return useMemo(() => buildIndex(model), [model]);
}

/** "Order service › Checkout" style path of an element's ancestors. */
export function scopePath(el: Element, index: ModelIndex): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let current = el.parentId ? index.byId.get(el.parentId) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = current.parentId ? index.byId.get(current.parentId) : undefined;
  }
  return names.join(' › ');
}
