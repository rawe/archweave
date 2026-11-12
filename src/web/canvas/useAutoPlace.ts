import { useEffect, useMemo, useRef, useState } from 'react';
import type { Position } from '../../shared/model.ts';
import { placeMissing, type LayoutEdge, type LayoutNode } from '../lib/layout.ts';
import { commit } from '../state/store.ts';

/**
 * Gives every node a position: stored ones as they are, missing ones placed by
 * ELK around them and persisted to the layout. Returns the merged positions and
 * whether placement is still running.
 */
export function useAutoPlace(
  key: string,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  stored: Record<string, Position> | undefined,
): { positions: Record<string, Position>; placing: boolean } {
  const [computed, setComputed] = useState<Record<string, Record<string, Position>>>({});
  const inflight = useRef(new Set<string>());
  const local = computed[key];

  const positions = useMemo(() => ({ ...(local ?? {}), ...(stored ?? {}) }), [local, stored]);
  const missing = useMemo(() => nodes.filter((n) => !positions[n.id]), [nodes, positions]);

  useEffect(() => {
    if (!missing.length) return;
    const signature = `${key}|${missing.map((n) => n.id).sort().join(',')}`;
    if (inflight.current.has(signature)) return;
    inflight.current.add(signature);
    const fixed: Record<string, Position> = {};
    for (const n of nodes) if (positions[n.id]) fixed[n.id] = positions[n.id]!;
    void placeMissing(nodes, edges, fixed).then((placed) => {
      if (!Object.keys(placed).length) return;
      setComputed((c) => ({ ...c, [key]: { ...(c[key] ?? {}), ...placed } }));
      void commit({ layout: { [key]: placed } }).finally(() => inflight.current.delete(signature));
    });
  }, [key, missing, nodes, edges, positions]);

  return { positions, placing: missing.length > 0 };
}
