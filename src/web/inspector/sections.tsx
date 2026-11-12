import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, Plus, X } from 'lucide-react';
import type { Element, Relation, RelationKind } from '../../shared/model.ts';
import { Picker } from '../chrome/Picker.tsx';
import { Tip } from '../chrome/primitives.tsx';
import { commit, navigateToElement, navigateToRelation, useStore } from '../state/store.ts';
import { scopePath, type ModelIndex } from '../state/selectors.ts';
import { slugify, uniqueId } from '../../shared/model.ts';
import { cx } from '../lib/dom.ts';
import { relativeTime } from '../lib/format.ts';
import { DATA_VERBS, KindIcon, RELATION_VERB } from '../lib/kinds.tsx';
import { Section } from './fields.tsx';
import { connect } from '../state/actions.ts';

// ─── Notes ──────────────────────────────────────────────────────────────────

export function Notes({ el }: { el: Element }) {
  const [draft, setDraft] = useState('');
  const [showResolved, setShowResolved] = useState(false);
  const open = el.notes.filter((n) => !n.resolved);
  const resolved = el.notes.filter((n) => n.resolved);
  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void commit({ summary: text.length <= 150 ? `Noted on ${el.name}: ${text}` : `Added a note to ${el.name}`, elements: [{ id: el.id, addNotes: [text] }] });
  };
  return (
    <Section label="Notes" className="notes">
      {open.length > 0 && (
        <ul className="note-list">
          {open.map((n) => (
            <li key={n.id} className={cx('note', `by-${n.author}`)}>
              <span className="note-author" aria-label={n.author === 'agent' ? 'Agent' : 'You'} />
              <div className="note-body">
                <p className="note-text">{n.text}</p>
                <span className="note-meta">
                  {n.author === 'agent' ? 'Agent' : 'You'} · {relativeTime(n.createdAt)}
                </span>
              </div>
              <Tip label="Resolve" side="left">
                <button
                  type="button"
                  className="row-remove"
                  aria-label="Resolve note"
                  onClick={() => void commit({ summary: `Resolved a note on ${el.name}`, elements: [{ id: el.id, resolveNotes: [n.id] }] })}
                >
                  <Check size={13} strokeWidth={1.8} />
                </button>
              </Tip>
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="note-input"
        rows={1}
        value={draft}
        placeholder="Note for the agent"
        aria-label="Note for the agent"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            add();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft('');
            (e.target as HTMLElement).blur();
          }
        }}
      />
      {resolved.length > 0 && (
        <div className="resolved">
          <button type="button" className="fold" onClick={() => setShowResolved((v) => !v)} aria-expanded={showResolved}>
            <ChevronRight size={12} strokeWidth={1.8} className={cx('fold-chev', showResolved && 'is-open')} aria-hidden />
            {resolved.length} resolved
          </button>
          {showResolved && (
            <ul className="note-list is-resolved">
              {resolved.map((n) => (
                <li key={n.id} className={cx('note', `by-${n.author}`)}>
                  <span className="note-author" />
                  <div className="note-body">
                    <p className="note-text">{n.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  );
}

// ─── Relations ──────────────────────────────────────────────────────────────

function RelationRow({ rel, other, dir, via }: { rel: Relation; other?: Element; dir: 'in' | 'out'; via?: Element }) {
  const unseen = useStore((s) => !!s.unseen[rel.id]);
  if (!other) return null;
  const verb = rel.label || RELATION_VERB[rel.kind];
  return (
    <li className="rel-row-wrap">
      <button type="button" className={cx('rel-row', rel.status === 'planned' && 'is-planned')} onClick={() => navigateToElement(other.id)}>
        {dir === 'out' ? <ArrowRight size={13} strokeWidth={1.7} className="rel-dir" aria-label="to" /> : <ArrowLeft size={13} strokeWidth={1.7} className="rel-dir" aria-label="from" />}
        <KindIcon kind={other.kind} size={13} className="rel-kind" />
        <span className="rel-text">
          <span className="rel-name">{other.name}</span>{' '}
          <span className="rel-verb">
            {verb}
            {via && <span className="rel-via"> · via {via.name}</span>}
          </span>
        </span>
        {unseen && <span className="dot-agent" aria-label="Changed by the agent" />}
      </button>
      <Tip label="Inspect relation" side="left">
        <button type="button" className="row-more" aria-label="Inspect relation" onClick={() => navigateToRelation(rel.id)}>
          <ChevronRight size={13} strokeWidth={1.8} />
        </button>
      </Tip>
    </li>
  );
}

/** Relations of the element and of everything inside it that cross its boundary. */
export function Relations({ el, index }: { el: Element; index: ModelIndex }) {
  const inside = new Set<string>([el.id]);
  const queue = [el.id];
  while (queue.length) for (const c of index.children.get(queue.shift()!) ?? []) if (!inside.has(c.id)) (inside.add(c.id), queue.push(c.id));
  const isDataLink = (r: Relation) => index.byId.get(r.from)?.kind === 'data' || index.byId.get(r.to)?.kind === 'data';
  const rows: { rel: Relation; dir: 'in' | 'out'; other?: Element; via?: Element }[] = [];
  for (const id of inside) {
    for (const r of index.out.get(id) ?? [])
      if (!inside.has(r.to) && !isDataLink(r)) rows.push({ rel: r, dir: 'out', other: index.byId.get(r.to), via: id === el.id ? undefined : index.byId.get(id) });
    for (const r of index.in.get(id) ?? [])
      if (!inside.has(r.from) && !isDataLink(r)) rows.push({ rel: r, dir: 'in', other: index.byId.get(r.from), via: id === el.id ? undefined : index.byId.get(id) });
  }
  const others = el.kind === 'data' ? [] : [...index.byId.values()].filter((e) => e.kind !== 'data' && e.id !== el.id);
  if (!rows.length && !others.length) return null;
  rows.sort((a, b) => (a.dir === b.dir ? Number(!!a.via) - Number(!!b.via) : a.dir === 'out' ? -1 : 1));
  return (
    <Section label="Relations" action={others.length > 0 ? <AddRelation el={el} others={others} index={index} /> : undefined}>
      {rows.length > 0 && (
        <ul className="rel-list">
          {rows.map((r) => (
            <RelationRow key={`${r.dir}-${r.rel.id}`} rel={r.rel} other={r.other} dir={r.dir} via={r.via} />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** A `uses` relation to or from any other element, also one on another canvas. */
function AddRelation({ el, others, index }: { el: Element; others: Element[]; index: ModelIndex }) {
  const [picking, setPicking] = useState(false);
  const [dir, setDir] = useState<'to' | 'from'>('to');
  const addRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={addRef} type="button" className="section-action" onClick={() => setPicking(true)}>
        <Plus size={13} strokeWidth={1.8} aria-hidden />
        Add
      </button>
      {picking && (
        <Picker
          anchor={addRef}
          placeholder={dir === 'to' ? `${el.name} uses…` : `Uses ${el.name}…`}
          items={others.map((o) => ({ id: o.id, label: o.name, detail: scopePath(o, index), icon: <KindIcon kind={o.kind} size={13} /> }))}
          onClose={() => setPicking(false)}
          onPick={(item) => (dir === 'to' ? connect(el.id, item.id) : connect(item.id, el.id))}
          header={
            <div className="verb-pick" role="radiogroup" aria-label="Direction">
              {(['to', 'from'] as const).map((d) => (
                <button key={d} type="button" role="radio" aria-checked={dir === d} className={cx('chip', dir === d && 'is-active')} onPointerDown={(e) => e.preventDefault()} onClick={() => setDir(d)}>
                  {d}
                </button>
              ))}
            </div>
          }
        />
      )}
    </>
  );
}

// ─── Data an element touches ────────────────────────────────────────────────

export function TouchedData({ el, index }: { el: Element; index: ModelIndex }) {
  const [picking, setPicking] = useState(false);
  const [verb, setVerb] = useState<RelationKind>('reads');
  const addRef = useRef<HTMLButtonElement>(null);
  const direct = (index.out.get(el.id) ?? []).filter((r) => index.byId.get(r.to)?.kind === 'data');
  const carried = new Map<string, Relation>();
  for (const r of [...(index.out.get(el.id) ?? []), ...(index.in.get(el.id) ?? [])])
    for (const d of r.dataIds) if (!direct.some((x) => x.to === d)) carried.set(d, r);

  const add = (dataId: string) => {
    const data = index.byId.get(dataId);
    if (!data) return;
    const id = uniqueId(slugify(`${el.id}-${verb}-${dataId}`), new Set(index.relById.keys()));
    void commit({
      summary: `${el.name} ${RELATION_VERB[verb]} ${data.name}`,
      relations: [{ id, from: el.id, to: dataId, kind: verb, status: el.status === 'built' && data.status === 'built' ? 'built' : 'planned' }],
    });
  };

  return (
    <Section
      label="Data"
      action={
        index.data.length > 0 ? (
          <button ref={addRef} type="button" className="section-action" onClick={() => setPicking(true)}>
            <Plus size={13} strokeWidth={1.8} aria-hidden />
            Add
          </button>
        ) : undefined
      }
    >
      {direct.length + carried.size > 0 && (
        <ul className="rel-list">
          {direct.map((r) => {
            const d = index.byId.get(r.to)!;
            return (
              <li key={r.id} className="rel-row-wrap">
                <button type="button" className={cx('rel-row', r.status === 'planned' && 'is-planned')} onClick={() => navigateToElement(d.id)}>
                  <span className="rel-verb is-lead">{RELATION_VERB[r.kind]}</span>
                  <KindIcon kind="data" size={13} className="rel-kind" />
                  <span className="rel-text">
                    <span className="rel-name">{d.name}</span>
                  </span>
                </button>
                <Tip label="Remove" side="left">
                  <button
                    type="button"
                    className="row-remove"
                    aria-label={`Remove ${r.kind} ${d.name}`}
                    onClick={() => void commit({ summary: `${el.name} no longer ${RELATION_VERB[r.kind]} ${d.name}`, remove: { relations: [r.id] } })}
                  >
                    <X size={13} strokeWidth={1.8} />
                  </button>
                </Tip>
              </li>
            );
          })}
          {[...carried.entries()].map(([dataId, r]) => {
            const d = index.byId.get(dataId);
            if (!d) return null;
            const other = index.byId.get(r.from === el.id ? r.to : r.from);
            return (
              <li key={`c-${dataId}`} className="rel-row-wrap">
                <button type="button" className="rel-row" onClick={() => navigateToElement(d.id)}>
                  <span className="rel-verb is-lead">{r.from === el.id ? 'sends' : 'receives'}</span>
                  <KindIcon kind="data" size={13} className="rel-kind" />
                  <span className="rel-text">
                    <span className="rel-name">{d.name}</span>
                    {other && <> <span className="rel-verb">{r.from === el.id ? `to ${other.name}` : `from ${other.name}`}</span></>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {picking && (
        <Picker
          anchor={addRef}
          placeholder={`Structure it ${RELATION_VERB[verb]}`}
          items={index.data.map((d) => ({ id: d.id, label: d.name, detail: scopePath(d, index), icon: <KindIcon kind="data" size={13} /> }))}
          onClose={() => setPicking(false)}
          onPick={(item) => add(item.id)}
          header={
            <div className="verb-pick" role="radiogroup" aria-label="Verb">
              {DATA_VERBS.map((v) => (
                <button key={v} type="button" role="radio" aria-checked={verb === v} className={cx('chip', verb === v && 'is-active')} onPointerDown={(e) => e.preventDefault()} onClick={() => setVerb(v)}>
                  {v}
                </button>
              ))}
            </div>
          }
        />
      )}
    </Section>
  );
}

// ─── Who uses a data structure ──────────────────────────────────────────────

export function UsedBy({ el, index }: { el: Element; index: ModelIndex }) {
  const rows: { verb: string; other: Element; relId: string }[] = [];
  for (const r of index.in.get(el.id) ?? []) {
    const other = index.byId.get(r.from);
    if (other && other.kind !== 'data') rows.push({ verb: RELATION_VERB[r.kind], other, relId: r.id });
  }
  for (const [, list] of index.out)
    for (const r of list)
      if (r.dataIds.includes(el.id)) {
        const a = index.byId.get(r.from);
        const b = index.byId.get(r.to);
        if (a && b) {
          rows.push({ verb: 'sends', other: a, relId: `${r.id}-a` });
          rows.push({ verb: 'receives', other: b, relId: `${r.id}-b` });
        }
      }
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const k = `${r.verb}:${r.other.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!unique.length) return null;
  const order = ['produces', 'writes', 'sends', 'receives', 'consumes', 'reads'];
  unique.sort((a, b) => order.indexOf(a.verb) - order.indexOf(b.verb) || a.other.name.localeCompare(b.other.name));
  return (
    <Section label="Used by">
      <ul className="rel-list">
        {unique.map((r) => (
          <li key={`${r.relId}-${r.verb}`} className="rel-row-wrap">
            <button type="button" className="rel-row" onClick={() => navigateToElement(r.other.id)} title="Show in Structure">
              <KindIcon kind={r.other.kind} size={13} className="rel-kind" />
              <span className="rel-text">
                <span className="rel-name">{r.other.name}</span> <span className="rel-verb">{r.verb}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}
