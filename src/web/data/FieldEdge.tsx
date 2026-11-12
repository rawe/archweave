import { memo } from 'react';
import { getBezierPath, Position, useInternalNode, type Edge, type EdgeProps } from '@xyflow/react';
import { cx } from '../lib/dom.ts';
import { arrowHead } from '../lib/geometry.ts';
import { rectOf } from '../canvas/ThreadEdge.tsx';
import { HEAD_H, ROW_H } from './DataCard.tsx';

export interface FieldEdgeData extends Record<string, unknown> {
  /** Row index of the field on the source card, or -1 for a card-to-card reference. */
  row: number;
  dim: boolean;
  lit: boolean;
  planned: boolean;
  fresh?: number;
}

export type FieldEdgeType = Edge<FieldEdgeData, 'field'>;

/** A thread from a field row (or card header) to the header of the structure it references. */
function FieldEdgeImpl({ source, target, data, selected }: EdgeProps<FieldEdgeType>) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t || !data || !s.measured.width || !t.measured.width) return null;
  const a = rectOf(s);
  const b = rectOf(t);
  const rightward = b.x + b.width / 2 >= a.x + a.width / 2;
  const sy = a.y + (data.row >= 0 ? HEAD_H + data.row * ROW_H + ROW_H / 2 : HEAD_H / 2);
  const ty = b.y + HEAD_H / 2;
  const sx = rightward ? a.x + a.width : a.x;
  const sideTarget = rightward ? Position.Left : Position.Right;
  const tip = { x: rightward ? b.x : b.x + b.width, y: ty, side: sideTarget };
  const head = arrowHead(tip);
  const [path] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: rightward ? Position.Right : Position.Left,
    targetX: head.base.x,
    targetY: head.base.y,
    targetPosition: sideTarget,
    curvature: 0.35,
  });
  return (
    <g className={cx('thread', 'is-field', data.planned && 'is-planned', data.dim && 'is-dim', (data.lit || selected) && 'is-lit')}>
      <path d={path} className="thread-hit" fill="none" />
      <path d={path} className="thread-line" fill="none" />
      <path d={head.path} className="thread-head" />
      <circle cx={sx} cy={sy} r={2.6} className="thread-origin" />
      {data.fresh && <path key={data.fresh} d={path} className="thread-fresh" fill="none" />}
    </g>
  );
}

export const FieldEdge = memo(FieldEdgeImpl);
