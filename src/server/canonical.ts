import { z } from 'zod';
import { Layout, Model } from '../shared/model.ts';

/**
 * The on-disk form of the model: arrays of identified entries sorted by id, keys
 * in schema order, default-valued fields omitted. Keeps Git diffs small.
 */
export function canonicalModel(model: Model): Record<string, unknown> {
  const sorted = {
    ...model,
    elements: sortById(model.elements),
    relations: sortById(model.relations),
    flows: sortById(model.flows),
  };
  const out = strip(Model, sorted) as Record<string, unknown>;
  return { version: 1, ...out };
}

export function canonicalLayout(layout: Layout): Layout {
  const out: Layout = {};
  for (const canvas of Object.keys(layout).sort()) {
    const positions = layout[canvas]!;
    const ids = Object.keys(positions).sort();
    if (!ids.length) continue;
    out[canvas] = Object.fromEntries(ids.map((id) => [id, { x: round(positions[id]!.x), y: round(positions[id]!.y) }]));
  }
  return out;
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function sortById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function strip(schema: z.ZodType, value: unknown): unknown {
  const inner = unwrap(schema);
  if (Array.isArray(value) && inner instanceof z.ZodArray) {
    return value.map((item) => strip(inner.element as z.ZodType, item));
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && inner instanceof z.ZodObject) {
    const shape = inner.shape as Record<string, z.ZodType>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || isDefault(shape[key]!, v)) continue;
      out[key] = strip(shape[key]!, v);
    }
    return out;
  }
  return value;
}

function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema;
  while (current instanceof z.ZodDefault || current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current.unwrap() as z.ZodType;
  }
  return current;
}

function isDefault(schema: z.ZodType, value: unknown): boolean {
  if (!(schema instanceof z.ZodDefault)) return false;
  return JSON.stringify(schema.parse(undefined)) === JSON.stringify(value);
}
