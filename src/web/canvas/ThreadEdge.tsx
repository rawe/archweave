import { memo } from 'react';
import { EdgeLabelRenderer, useInternalNode, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { Relation } from '../../shared/model.ts';
import { Tip } from '../chrome/primitives.tsx';
import { cx } from '../lib/dom.ts';
import { arrowHead, floatingAnchors, type Rect } from '../lib/geometry.ts';
import { curve, type Route } from '../lib/ports.ts';
import { RELATION_VERB } from '../lib/kinds.tsx';

export interface ThreadData extends Record<string, unknown> {
  relations: Relation[];
  dim: boolean;
  focus: boolean;
  hover: boolean;
  fresh?: number;
  planned: boolean;
  carries: { id: string; name: string }[];
  showLabel: boolean;
  /** Attachment points from port assignment; without it the thread runs between the centers. */
  route?: Route;
  onSelect?: (id: string) => void;
}

export type ThreadEdgeType = Edge<ThreadData, 'thread'>;

export function rectOf(node: InternalNode): Rect {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? node.width ?? 0,
    height: node.measured.height ?? node.height ?? 0,
  };
}

export function threadLabel(relations: Relation[]): string {
  if (relations.length !== 1) return '';
  const r = relations[0]!;
  return r.label || (r.kind === 'uses' ? '' : RELATION_VERB[r.kind]);
}

function ThreadEdgeImpl({ id, source, target, data, selected }: EdgeProps<ThreadEdgeType>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t || !data || !s.measured.width || !t.measured.width) return null;

  const { source: a, target: b } = data.route ?? floatingAnchors(rectOf(s), rectOf(t));
  const head = arrowHead(b, 6, 5);
  const { path, mid } = curve(a, { ...head.base, side: b.side });
  const labelX = mid.x;
  const labelY = mid.y;

  const count = data.relations.length;
  const label = threadLabel(data.relations);
  const lit = selected || data.focus;
  // A label wider than its thread would sit on top of the nodes; such labels wait for hover.
  const fits = Math.hypot(b.x - a.x, b.y - a.y) >= Math.min(label.length * 6.4, 200) + 40;
  const showText = !!label && (data.hover || ((data.showLabel || lit) && fits));
  // At rest a merged thread shows only its data diamond; the count appears on focus, hover or close zoom.
  const showCount = count > 1 && (lit || data.hover || data.showLabel);
  const hasMarker = data.carries.length > 0 || showCount;
  const cls = cx(
    'thread',
    data.planned && 'is-planned',
    data.dim && 'is-dim',
    lit && 'is-lit',
    selected && 'is-selected',
    data.hover && 'is-hover',
  );

  return (
    <>
      <g className={cls}>
        <path d={path} className="thread-hit" fill="none" />
        <path d={path} className="thread-line" fill="none" />
        <path d={head.path} className="thread-head" />
        {data.fresh && <path key={data.fresh} d={path} className="thread-fresh" fill="none" />}
      </g>
      {(showText || hasMarker) && (
        <EdgeLabelRenderer>
          <div
            className={cx('thread-label nodrag nopan', data.dim && 'is-dim', lit && 'is-lit', showText && 'has-text')}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={() => data.onSelect?.(id)}
          >
            {data.carries.length > 0 && (
              <Tip label={`Carries ${data.carries.map((c) => c.name).join(', ')}`} side="top">
                <span className="thread-diamond" aria-label={`Carries ${data.carries.map((c) => c.name).join(', ')}`} />
              </Tip>
            )}
            {showText && <span className="thread-text">{label}</span>}
            {showCount && (
              <span className="thread-count" title={`${count} relations`}>
                {count}
              </span>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const ThreadEdge = memo(ThreadEdgeImpl);
