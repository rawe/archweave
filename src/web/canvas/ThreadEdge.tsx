import { memo } from 'react';
import { EdgeLabelRenderer, getBezierPath, useInternalNode, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { Relation } from '../../shared/model.ts';
import { Tip } from '../chrome/primitives.tsx';
import { cx } from '../lib/dom.ts';
import { arrowHead, floatingAnchors, sideNormal, type Rect } from '../lib/geometry.ts';
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
  /** Sideways shift when a thread runs the other way between the same pair. */
  shift: number;
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

  const { source: a, target: b } = floatingAnchors(rectOf(s), rectOf(t), data.shift);
  const head = arrowHead(b);
  const start = { x: a.x + sideNormal(a.side).x * 1, y: a.y + sideNormal(a.side).y * 1 };
  const [path, labelX, labelY] = getBezierPath({
    sourceX: start.x,
    sourceY: start.y,
    sourcePosition: a.side,
    targetX: head.base.x,
    targetY: head.base.y,
    targetPosition: b.side,
    curvature: 0.3,
  });

  const count = data.relations.length;
  const label = threadLabel(data.relations);
  const lit = selected || data.focus;
  const showText = (data.showLabel || lit || data.hover) && !!label;
  const hasMarker = data.carries.length > 0 || count > 1;
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
            {count > 1 && (
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
