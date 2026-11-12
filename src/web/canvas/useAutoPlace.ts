import { useEffect, useMemo, useRef, useState } from 'react';
import type { Position } from '../../shared/model.ts';
import { layoutAll, looksAutoPlaced, placeMissing, type LayoutEdge, type LayoutNode } from '../lib/layout.ts';
import { commit, getState } from '../state/store.ts';

/**
 * Gives every node a position: stored ones as they are, missing ones placed by
 * ELK around them and persisted to the layout. A stored layout that the earlier
 * auto-layout wrote and nobody arranged since is laid out afresh.
 *
 * Layout runs asynchronously, so its result is checked against the model and
 * layout at completion: positions the human set meanwhile win, and nodes that
 * no longer exist are not written back.
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
  // Bumped when a job's result had to be dropped, so placement runs again for the current state.
  const [retry, setRetry] = useState(0);
  const replace = useMemo(() => looksAutoPlaced(stored), [stored]);
  const local = computed[key];

  const positions = useMemo(() => (replace ? {} : { ...(local ?? {}), ...(stored ?? {}) }), [replace, local, stored]);
  const missing = useMemo(() => nodes.filter((n) => !positions[n.id]), [nodes, positions]);

  const latest = useRef({ key, nodes });
  latest.current = { key, nodes };

  useEffect(() => {
    if (!missing.length) return;
    if (measured && (replace ? nodes : missing).some((n) => !measured.has(n.id))) return;
    const signature = `${key}|${replace ? '*' : ''}${missing.map((n) => n.id).sort().join(',')}`;
    if (inflight.current.has(signature)) return;
    inflight.current.add(signature);
    const storedAtStart = getState().layout[key];
    const fixed: Record<string, Position> = {};
    if (!replace) for (const n of nodes) if (positions[n.id]) fixed[n.id] = positions[n.id]!;
    const job = replace ? layoutAll(nodes, edges) : placeMissing(nodes, edges, fixed);

    void job
      .then(async (placed) => {
        const now = latest.current;
        if (now.key !== key) return;
        const alive = new Set(now.nodes.map((n) => n.id));
        const current = getState().layout[key] ?? {};
        const out: Record<string, Position | null> = {};
        if (replace) {
          // Anything the human did to this canvas meanwhile makes the fresh layout obsolete.
          if (!samePositions(current, storedAtStart ?? {})) return setRetry((n) => n + 1);
          for (const [id, p] of Object.entries(placed)) if (alive.has(id)) out[id] = p;
          for (const id of Object.keys(current)) if (!alive.has(id)) out[id] = null;
        } else {
          for (const [id, p] of Object.entries(placed)) if (alive.has(id) && !current[id]) out[id] = p;
        }
        if (!Object.keys(out).length) return;
        const fresh = Object.fromEntries(Object.entries(out).filter((e): e is [string, Position] => !!e[1]));
        setComputed((c) => ({ ...c, [key]: replace ? fresh : { ...(c[key] ?? {}), ...fresh } }));
        await commit({ layout: { [key]: out } });
      })
      .finally(() => {
        inflight.current.delete(signature);
        // A snapshot that arrived while this job ran found it in flight and skipped; give it its turn.
        if (latest.current.nodes !== nodes) setRetry((n) => n + 1);
      });
  }, [key, missing, nodes, edges, positions, replace, measured, retry]);

  return { positions, placing: missing.length > 0 };
}

function samePositions(a: Record<string, Position>, b: Record<string, Position>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k]!.x === b[k]?.x && a[k]!.y === b[k]?.y);
}
