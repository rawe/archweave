import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Link2, MessageSquare } from 'lucide-react';
import type { Element } from '../../shared/model.ts';
import { cx } from '../lib/dom.ts';
import { KindIcon } from '../lib/kinds.tsx';

export const CARD_W = 252;
export const HEAD_H = 44;
export const ROW_H = 26;
export const CARD_PAD = 8;

export function cardHeight(el: Element): number {
  return HEAD_H + Math.max(1, el.fields.length) * ROW_H + CARD_PAD;
}

export interface DataCardData extends Record<string, unknown> {
  element: Element;
  dim: boolean;
  related: boolean;
  fresh?: number;
  unseen: boolean;
  stale: boolean;
  /** Field names whose threads are in focus. */
  litFields: string[];
  refNames: Record<string, string>;
  leaving: boolean;
}

export type DataCardType = Node<DataCardData, 'card'>;

function DataCardImpl({ data, selected }: NodeProps<DataCardType>) {
  const el = data.element;
  const openNotes = el.notes.filter((n) => !n.resolved).length;
  return (
    <div
      className={cx(
        'card',
        `status-${el.status}`,
        selected && 'is-selected',
        data.dim && 'is-dim',
        data.related && 'is-related',
        data.leaving && 'is-leaving',
      )}
      style={{ width: CARD_W }}
    >
      {data.fresh && <span key={data.fresh} className="node-ring" aria-hidden />}
      <Handle type="source" position={Position.Right} id="anchor" className="handle-anchor" isConnectable={false} />
      <Handle type="target" position={Position.Left} id="in" className="handle-anchor" isConnectable={false} />
      <div className="card-head" style={{ height: HEAD_H }}>
        <span className="node-icon">
          <KindIcon kind="data" size={14} />
        </span>
        <span className="node-name">{el.name}</span>
        {openNotes > 0 && (
          <span className="node-mark node-notes" title={`${openNotes} open notes`}>
            <MessageSquare size={11} strokeWidth={1.8} aria-hidden />
          </span>
        )}
        {data.stale && <span className="node-mark node-stale" title="A code link no longer matches the code" />}
        {el.format && <span className="card-format mono">{el.format}</span>}
        {data.unseen && <span className="node-unseen" title="Changed by the agent" />}
      </div>
      <ul className="card-fields">
        {el.fields.map((f) => (
          <li key={f.name} className={cx('card-field', data.litFields.includes(f.name) && 'is-lit')} style={{ height: ROW_H }}>
            <span className="card-field-name">
              {f.name}
              {f.optional && <span className="card-opt">?</span>}
            </span>
            <span className="card-field-type mono">{f.type}</span>
            {f.ref && (
              <span className="card-link" title={`Links to ${data.refNames[f.ref] ?? f.ref}`}>
                <Link2 size={11} strokeWidth={1.9} aria-hidden />
              </span>
            )}
          </li>
        ))}
        {!el.fields.length && (
          <li className="card-field is-empty" style={{ height: ROW_H }}>
            No fields yet
          </li>
        )}
      </ul>
    </div>
  );
}

export const DataCard = memo(DataCardImpl);
