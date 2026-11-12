import { memo } from 'react';
import { Handle, Position, useConnection, type Node, type NodeProps } from '@xyflow/react';
import { ArrowUpRight, MessageSquare } from 'lucide-react';
import type { Element } from '../../shared/model.ts';
import { cx } from '../lib/dom.ts';
import { KindIcon, KIND_LABEL } from '../lib/kinds.tsx';
import { chipWidth } from './nodeSize.ts';

export interface ElementNodeData extends Record<string, unknown> {
  element: Element;
  role: 'inside' | 'neighbor';
  childCount: number;
  dim: boolean;
  related: boolean;
  fresh?: number;
  unseen: boolean;
  /** Something inside changed and has not been looked at. */
  unseenInside?: boolean;
  stale: boolean;
  openNotes: number;
  dropTarget: boolean;
  leaving: boolean;
  onOpen?: (id: string) => void;
}

export type ElementNodeType = Node<ElementNodeData, 'element'>;

const SIDES = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const;

function ElementNodeImpl({ id, data, selected }: NodeProps<ElementNodeType>) {
  const { element: el, role, childCount } = data;
  const connection = useConnection();
  const connectingHere = connection.inProgress && connection.fromNode.id !== id;
  const neighbor = role === 'neighbor';

  if (neighbor)
    return (
      <div
        className={cx(
          'node',
          'is-neighbor',
          `status-${el.status}`,
          selected && 'is-selected',
          data.dim && 'is-dim',
          data.related && 'is-related',
          data.leaving && 'is-leaving',
        )}
        style={{ width: chipWidth(el.name) }}
        title={`${KIND_LABEL[el.kind] ?? el.kind} outside this scope`}
        data-id={id}
      >
        {data.fresh && <span key={data.fresh} className="node-ring" aria-hidden />}
        <Handle type="source" position={Position.Top} id="anchor" className="handle-anchor" isConnectable={false} />
        <Handle type="target" position={Position.Top} id="in" className={cx('handle-in', connectingHere && 'is-live')} />
        <span className="node-name">{el.name}</span>
        {data.unseen && <span className="node-unseen" title="Changed by the agent" />}
      </div>
    );

  return (
    <div
      className={cx(
        'node',
        `kind-${el.kind}`,
        `status-${el.status}`,
        selected && 'is-selected',
        data.dim && 'is-dim',
        data.related && 'is-related',
        data.dropTarget && 'is-drop-target',
        connectingHere && 'is-connect-target',
        childCount > 0 && 'has-children',
        data.leaving && 'is-leaving',
      )}
      data-id={id}
    >
      {childCount > 0 && <span className="node-stack" aria-hidden />}
      {data.fresh && <span key={data.fresh} className="node-ring" aria-hidden />}
      <Handle type="source" position={Position.Top} id="anchor" className="handle-anchor" isConnectable={false} />
      <Handle type="target" position={Position.Top} id="in" className={cx('handle-in', connectingHere && 'is-live')} />
      {SIDES.map((side) => (
        <Handle key={side} type="source" position={side} id={`out-${side}`} className="handle-out" />
      ))}

      <div className="node-head">
        <span className="node-icon">
          <KindIcon kind={el.kind} size={14} />
        </span>
        <span className="node-name">{el.name}</span>
        {data.openNotes > 0 && (
          <span className="node-mark node-notes" title={`${data.openNotes} open ${data.openNotes === 1 ? 'note' : 'notes'}`}>
            <MessageSquare size={11} strokeWidth={1.8} aria-hidden />
          </span>
        )}
        {data.stale && <span className="node-mark node-stale" title="A code link no longer matches the code" />}
        {data.unseen ? (
          <span className="node-unseen" title="Changed by the agent" />
        ) : (
          data.unseenInside && <span className="node-unseen is-inside" title="The agent changed something inside" />
        )}
      </div>
      {el.summary && <div className="node-summary">{el.summary}</div>}
      {childCount > 0 && (
        <button
          type="button"
          className="node-open nodrag"
          onClick={(e) => {
            e.stopPropagation();
            data.onOpen?.(id);
          }}
          tabIndex={-1}
        >
          {childCount} inside
          <ArrowUpRight size={12} strokeWidth={1.8} aria-hidden />
        </button>
      )}
    </div>
  );
}

export const ElementNode = memo(ElementNodeImpl);
