import { useCallback, useLayoutEffect, useState } from 'react';
import { applyNodeChanges, type Node, type NodeChange } from '@xyflow/react';

/**
 * Keeps React Flow's node state in step with nodes derived from the model,
 * without losing measured sizes or the position of a node being dragged when
 * a new snapshot arrives mid-gesture.
 */
export function useSyncedNodes<N extends Node>(
  derived: N[],
  onSelect: (changes: { id: string; selected: boolean }[]) => void,
): [N[], (changes: NodeChange<N>[]) => void] {
  const [nodes, setNodes] = useState<N[]>(derived);

  useLayoutEffect(() => {
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return derived.map((d) => {
        const p = byId.get(d.id);
        if (!p) return d;
        return { ...d, measured: p.measured, position: p.dragging ? p.position : d.position, dragging: p.dragging };
      });
    });
  }, [derived]);

  const onNodesChange = useCallback(
    (changes: NodeChange<N>[]) => {
      const selects: { id: string; selected: boolean }[] = [];
      const rest: NodeChange<N>[] = [];
      for (const c of changes) {
        if (c.type === 'select') selects.push({ id: c.id, selected: c.selected });
        else if (c.type !== 'remove' && c.type !== 'add' && c.type !== 'replace') rest.push(c);
      }
      if (rest.length) setNodes((nds) => applyNodeChanges(rest, nds));
      if (selects.length) onSelect(selects);
    },
    [onSelect],
  );

  return [nodes, onNodesChange];
}
