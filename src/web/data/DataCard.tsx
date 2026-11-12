import { memo } from 'react';
import { Position, type Node, type NodeProps } from '@xyflow/react';
import { ArrowRight, Link2, MessageSquare } from 'lucide-react';
import { cx } from '../lib/dom.ts';
import { arrowHead } from '../lib/geometry.ts';
import { curve } from '../lib/ports.ts';
import { KindIcon } from '../lib/kinds.tsx';
import { plural } from '../lib/format.ts';
import { MORE, type FocusCard, type FocusThread, type UserGroup } from './focusLayout.ts';

/** What is under the pointer in the focus view: a side structure, or a row on the center card. */
export type FocusHover = { neighbor?: string; centerRow?: number } | null;

export interface DataCardData extends Record<string, unknown> {
  card: FocusCard;
  hover: FocusHover;
  fresh?: number;
  unseen: boolean;
  stale: boolean;
  /** Names of referenced structures, for the link glyph's tooltip. */
  refNames: Record<string, string>;
  ownerName?: string;
  onHover: (h: FocusHover) => void;
  onFocus: (id: string) => void;
  onOwner?: () => void;
  /** Shows all fields of a side card, or only the linking ones again. */
  onToggleFields?: (id: string) => void;
  leaving?: boolean;
}

export type DataCardType = Node<DataCardData, 'card'>;

function DataCardImpl({ data }: NodeProps<DataCardType>) {
  const { card, hover } = data;
  const el = card.element;
  const center = card.role === 'center';
  const openNotes = el.notes.filter((n) => !n.resolved).length;
  const lit = !center && hover?.neighbor === card.id;
  const rowLit = (index: number, ref?: string) => (center ? hover?.centerRow === index || (!!ref && hover?.neighbor === ref) : lit);

  return (
    <div
      className={cx('dcard', `is-${card.role}`, `status-${el.status}`, lit && 'is-lit', data.leaving && 'is-leaving')}
      style={{ width: card.w, height: card.h }}
      onPointerEnter={() => !center && data.onHover({ neighbor: card.id })}
      onPointerLeave={() => !center && data.onHover(null)}
      onClick={() => !center && data.onFocus(card.id)}
      role={center ? undefined : 'button'}
      aria-label={center ? undefined : `Focus ${el.name}`}
      tabIndex={center ? undefined : 0}
      onKeyDown={(e) => {
        if (!center && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          data.onFocus(card.id);
        }
      }}
    >
      {data.fresh && <span key={data.fresh} className="node-ring" aria-hidden />}
      <div className="dcard-head" style={{ height: card.head }}>
        <div className="dcard-title">
          {center && (
            <span className="node-icon">
              <KindIcon kind="data" size={15} />
            </span>
          )}
          <span className="dcard-name">{el.name}</span>
          {openNotes > 0 && (
            <span className="node-mark" title={`${plural(openNotes, 'open note')}`}>
              <MessageSquare size={11} strokeWidth={1.8} aria-hidden />
            </span>
          )}
          {data.stale && <span className="node-stale" title="A code link no longer matches the code" />}
          {el.format && <span className="dcard-format mono">{el.format}</span>}
          {data.unseen && <span className="node-unseen" title="Changed by the agent" />}
        </div>
        {center && data.ownerName && (
          <button
            type="button"
            className="dcard-owner nodrag"
            onClick={(e) => {
              e.stopPropagation();
              data.onOwner?.();
            }}
          >
            in {data.ownerName}
          </button>
        )}
      </div>
      <ul className="dcard-fields">
        {card.rows.map(({ field: f, index, stacked }) => {
          const linkable = center && f.ref && f.ref !== el.id && data.refNames[f.ref];
          return (
            <li
              key={`${index}-${f.name}`}
              className={cx('dcard-field', rowLit(index, f.ref) && 'is-lit', linkable && 'is-linkable', f.ref && 'has-link', stacked && 'is-stacked')}
              style={{ height: rowHeightOf(card, index) }}
              onPointerEnter={center ? () => data.onHover({ centerRow: index, neighbor: f.ref && f.ref !== el.id ? f.ref : undefined }) : undefined}
              onPointerLeave={center ? () => data.onHover(null) : undefined}
              onClick={
                linkable
                  ? (e) => {
                      e.stopPropagation();
                      data.onFocus(f.ref!);
                    }
                  : undefined
              }
              title={f.description || undefined}
            >
              <span className="dcard-field-name">
                {f.name}
                {f.optional && <span className="dcard-opt">?</span>}
              </span>
              <span className="dcard-field-type mono">
                {f.type}
              </span>
              {f.ref && (
                <span className="dcard-link" title={f.ref === el.id ? 'Refers to itself' : `Links to ${data.refNames[f.ref] ?? f.ref}`}>
                  <Link2 size={12} strokeWidth={1.9} aria-hidden />
                </span>
              )}
            </li>
          );
        })}
        {center && !card.rows.length && (
          <li className="dcard-field is-empty" style={{ height: 28 }}>
            No fields yet
          </li>
        )}
      </ul>
      {(card.more > 0 || card.canCollapse) && (
        <button
          type="button"
          className="dcard-more nodrag"
          style={{ height: MORE }}
          onClick={(e) => {
            e.stopPropagation();
            data.onToggleFields?.(card.id);
          }}
        >
          {card.more > 0 ? (card.rows.length ? plural(card.more, 'more field') : plural(card.more, 'field')) : 'Only the linking fields'}
        </button>
      )}
    </div>
  );
}

export const DataCard = memo(DataCardImpl);

function rowHeightOf(card: FocusCard, index: number): number {
  return card.rows.find((r) => r.index === index)?.h ?? 28;
}

// ─── Threads ────────────────────────────────────────────────────────────────

export interface ThreadsData extends Record<string, unknown> {
  threads: FocusThread[];
  origin: { x: number; y: number };
  width: number;
  height: number;
  hover: FocusHover;
}

export type ThreadsNodeType = Node<ThreadsData, 'threads'>;

/** Every thread of the focus view in one quiet SVG layer beneath the cards. */
function ThreadsNodeImpl({ data }: NodeProps<ThreadsNodeType>) {
  const { origin, hover } = data;
  const isLit = (t: FocusThread) =>
    !!hover && ((hover.neighbor !== undefined && hover.neighbor === t.neighbor) || (hover.centerRow !== undefined && hover.centerRow === t.centerRow));
  const anyLit = data.threads.some(isLit);
  return (
    <svg className={cx('dthreads', anyLit && 'has-lit')} width={data.width} height={data.height} aria-hidden>
      {[...data.threads].sort((p, q) => Number(isLit(p)) - Number(isLit(q))).map((t) => {
        const fromSide = t.toward === 'right' ? Position.Right : Position.Left;
        const toSide = t.toward === 'right' ? Position.Left : Position.Right;
        const tip = { x: t.to.x - origin.x, y: t.to.y - origin.y, side: toSide };
        const head = arrowHead(tip, 6, 5);
        const start = { x: t.from.x - origin.x, y: t.from.y - origin.y, side: fromSide };
        const path = t.spine !== undefined ? comb(start, head.base, t.spine - origin.x) : curve(start, { ...head.base, side: toSide }).path;
        return (
          <g key={t.id} className={cx('thread', 'is-field', t.planned && 'is-planned', isLit(t) && 'is-lit')}>
            <path d={path} className="thread-line" fill="none" />
            <path d={head.path} className="thread-head" />
            <circle cx={start.x} cy={start.y} r={2.6} className="thread-origin" />
          </g>
        );
      })}
    </svg>
  );
}

export const ThreadsNode = memo(ThreadsNodeImpl);

/** A horizontal stub from the row, a rounded turn onto the spine, along it, and a rounded turn into the target. */
function comb(a: { x: number; y: number }, b: { x: number; y: number }, spine: number): string {
  const dy = b.y - a.y;
  if (Math.abs(dy) < 1) return `M ${a.x} ${a.y} H ${b.x}`;
  const r = Math.min(8, Math.abs(dy) / 2);
  const dir = Math.sign(dy);
  const sx = Math.sign(spine - a.x) || 1;
  const tx = Math.sign(b.x - spine) || 1;
  return [
    `M ${a.x} ${a.y}`,
    `H ${spine - sx * r}`,
    `Q ${spine} ${a.y} ${spine} ${a.y + dir * r}`,
    `V ${b.y - dir * r}`,
    `Q ${spine} ${b.y} ${spine + tx * r} ${b.y}`,
    `H ${b.x}`,
  ].join(' ');
}

// ─── Users ──────────────────────────────────────────────────────────────────

export interface UsersData extends Record<string, unknown> {
  groups: UserGroup[];
  width: number;
  onOpen: (id: string) => void;
}

export type UsersNodeType = Node<UsersData, 'users'>;

/** The elements that touch the focused structure, grouped by verb. Each one jumps to the Structure perspective. */
function UsersNodeImpl({ data }: NodeProps<UsersNodeType>) {
  return (
    <div className="dusers" style={{ width: data.width }}>
      <span className="dusers-stem" aria-hidden />
      {data.groups.map((g) => (
        <section key={g.label} className="dusers-group">
          <h4 className="dusers-label">{g.label}</h4>
          <ul className="dusers-list">
            {g.items.map((u) => (
              <li key={u.key}>
                <button type="button" className="duser nodrag" onClick={() => data.onOpen(u.element.id)} title={`Show ${u.element.name} in Structure`}>
                  <KindIcon kind={u.element.kind} size={12} />
                  <span className="duser-name">{u.element.name}</span>
                  {u.peer && (
                    <>
                      <ArrowRight size={11} strokeWidth={1.8} aria-hidden className="duser-arrow" />
                      <span className="duser-name">{u.peer.name}</span>
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export const UsersNode = memo(UsersNodeImpl);
