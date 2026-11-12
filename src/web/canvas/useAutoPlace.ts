import { useEffect, useMemo, useRef, useState } from 'react';
import type { Position } from '../../shared/model.ts';
import { placeMissing, placementToSave, shownPositions, type LayoutEdge, type LayoutNode } from '../lib/layout.ts';
import { commit, getState } from '../state/store.ts';

/**
 * Gives every node a position: stored ones as they are, missing ones placed by ELK around them.
 * Stored positions are never replaced; only Tidy re-lays a scope.
 *
 * Layout runs asynchronously, so its result is checked at completion: positions the human set meanwhile
 * win, and nodes that no longer exist are not written. Computed positions are kept in this browser before
 * they are saved, so a save that fails leaves nothing missing and starts no new placement; the next
 * placement happens when the model brings new nodes (or after a reload).
 */
export function useAutoPlace(
  key: string,
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  stored: Record<string, Position> | undefined,
  /** When given, placement waits until every node to place has been measured. */
  measured?: ReadonlySet<string>,
): { positions: Record<string, Position>; placing: boolean } {
  const [computed, setComputed] = useState<Record<string, Record<string, Position>>>({});
  const inflight = useRef(new Set<string>());
  const local = computed[key];

  const positions = useMemo(() => shownPositions(stored, local), [stored, local]);
  const missing = useMemo(() => nodes.filter((n) => !positions[n.id]), [nodes, positions]);

  const latest = useRef({ key, nodes });
  latest.current = { key, nodes };

  useEffect(() => {
    if (!missing.length) return;
    if (measured && missing.some((n) => !measured.has(n.id))) return;
    // One job per set of missing nodes; a snapshot arriving meanwhile with the same missing nodes waits for it.
    const signature = `${key}|${missing.map((n) => n.id).sort().join(',')}`;
    if (inflight.current.has(signature)) return;
    inflight.current.add(signature);
    const fixed: Record<string, Position> = {};
    for (const n of nodes) if (positions[n.id]) fixed[n.id] = positions[n.id]!;

    void placeMissing(nodes, edges, fixed)
      .then((placed) => {
        const now = latest.current;
        if (now.key !== key) return;
        const out = placementToSave(placed, new Set(now.nodes.map((n) => n.id)), getState().layout[key] ?? {});
        if (!Object.keys(out).length) return;
        setComputed((c) => ({ ...c, [key]: { ...(c[key] ?? {}), ...out } }));
        void commit({ layout: { [key]: out } });
      })
      .finally(() => inflight.current.delete(signature));
  }, [key, missing, nodes, edges, positions, measured]);

  return { positions, placing: missing.length > 0 };
}
