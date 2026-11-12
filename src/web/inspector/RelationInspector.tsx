import { useRef, useState } from 'react';
import { ArrowRight, Plus, Trash, X } from 'lucide-react';
import { RELATION_KINDS, type Relation, type RelationKind } from '../../shared/model.ts';
import type { PlainRelationPatch } from '../state/apply.ts';
import { Picker } from '../chrome/Picker.tsx';
import { Tip } from '../chrome/primitives.tsx';
import { deleteSelection } from '../state/actions.ts';
import { commit, navigateToElement, setState, useStore } from '../state/store.ts';
import { scopePath, type ModelIndex } from '../state/selectors.ts';
import { cx } from '../lib/dom.ts';
import { KindIcon, RELATION_VERB } from '../lib/kinds.tsx';
import { CodeRefs } from './CodeRefs.tsx';
import { InlineText, MarkdownField, Section, Segmented } from './fields.tsx';
import { STATUS_OPTIONS } from './ElementInspector.tsx';

export function RelationInspector({ relations, index, edgeKey }: { relations: Relation[]; index: ModelIndex; edgeKey?: string }) {
  if (relations.length > 1) return <MergedInspector relations={relations} index={index} edgeKey={edgeKey} />;
  const rel = relations[0];
  if (!rel) return null;
  return <SingleRelation rel={rel} index={index} />;
}

function Endpoints({ rel, index }: { rel: Relation; index: ModelIndex }) {
  const from = index.byId.get(rel.from);
  const to = index.byId.get(rel.to);
  return (
    <div className="endpoints">
      <button type="button" className="endpoint" onClick={() => from && navigateToElement(from.id)}>
        {from && <KindIcon kind={from.kind} size={14} />}
        <span>{from?.name ?? rel.from}</span>
      </button>
      <ArrowRight size={14} strokeWidth={1.7} className="endpoint-arrow" aria-label="to" />
      <button type="button" className="endpoint" onClick={() => to && navigateToElement(to.id)}>
        {to && <KindIcon kind={to.kind} size={14} />}
        <span>{to?.name ?? rel.to}</span>
      </button>
    </div>
  );
}

function SingleRelation({ rel, index }: { rel: Relation; index: ModelIndex }) {
  const focusLabel = useStore((s) => s.labelFocusFor === rel.id);
  const from = index.byId.get(rel.from);
  const to = index.byId.get(rel.to);
  const name = `${from?.name ?? rel.from} → ${to?.name ?? rel.to}`;
  const patch = (p: Omit<PlainRelationPatch, 'id'>, summary?: string) => void commit({ summary, relations: [{ id: rel.id, ...p }] });
  const [picking, setPicking] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="inspector-body">
      <header className="insp-head">
        <Endpoints rel={rel} index={index} />
        <div className="insp-meta">
          <label className="select-wrap">
            <span className="sr-only">Kind</span>
            <select value={rel.kind} onChange={(e) => patch({ kind: e.target.value as RelationKind })}>
              {RELATION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {RELATION_VERB[k]}
                </option>
              ))}
            </select>
          </label>
          <Segmented label="Status" value={rel.status} options={STATUS_OPTIONS} onChange={(status) => patch({ status })} />
        </div>
      </header>
      <InlineText
        multiline
        className="insp-summary"
        value={rel.label}
        placeholder="Label, the verb: “places order”"
        label="Label"
        maxLength={80}
        autoFocus={focusLabel}
        onFocused={() => setState({ labelFocusFor: undefined })}
        onCommit={(label) => patch({ label })}
      />
      <InlineText className="insp-tech-line" value={rel.technology ?? ''} placeholder="Technology, e.g. HTTPS/JSON" label="Technology" onCommit={(technology) => patch({ technology })} />
      <div className="insp-desc">
        <MarkdownField value={rel.description} onCommit={(description) => patch({ description })} placeholder="Add a description" label="Description" />
      </div>
      <Section
        label="Data carried"
        action={
          index.data.length > 0 ? (
            <button ref={addRef} type="button" className="section-action" onClick={() => setPicking(true)}>
              <Plus size={13} strokeWidth={1.8} aria-hidden />
              Add
            </button>
          ) : undefined
        }
      >
        {rel.dataIds.length > 0 && (
          <div className="chips">
            {rel.dataIds.map((id) => {
              const d = index.byId.get(id);
              return (
                <span key={id} className="chip chip-data">
                  <button type="button" className="chip-main" onClick={() => navigateToElement(id)}>
                    <KindIcon kind="data" size={12} />
                    {d?.name ?? id}
                  </button>
                  <button type="button" className="chip-x" aria-label={`Remove ${d?.name ?? id}`} onClick={() => patch({ dataIds: rel.dataIds.filter((x) => x !== id) })}>
                    <X size={11} strokeWidth={2} />
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {picking && (
          <Picker
            anchor={addRef}
            placeholder="Structure carried"
            items={index.data.filter((d) => !rel.dataIds.includes(d.id)).map((d) => ({ id: d.id, label: d.name, detail: scopePath(d, index), icon: <KindIcon kind="data" size={13} /> }))}
            onClose={() => setPicking(false)}
            onPick={(item) => patch({ dataIds: [...rel.dataIds, item.id] }, `${name} now carries ${item.label}`)}
          />
        )}
      </Section>
      <CodeRefs owner={{ type: 'relation', id: rel.id }} refs={rel.codeRefs} onChange={(codeRefs) => patch({ codeRefs })} />
      <footer className="insp-foot">
        <span className="foot-id mono">{rel.id}</span>
        <span className="foot-spacer" />
        <Tip label="Delete relation" keys="⌫" side="top">
          <button type="button" className="foot-btn is-danger" aria-label="Delete relation" onClick={() => void deleteSelection()}>
            <Trash size={14} strokeWidth={1.7} />
          </button>
        </Tip>
      </footer>
    </div>
  );
}

function MergedInspector({ relations, index, edgeKey }: { relations: Relation[]; index: ModelIndex; edgeKey?: string }) {
  const [a, b] = (edgeKey ?? '').split('->');
  const from = a ? index.byId.get(a) : undefined;
  const to = b ? index.byId.get(b) : undefined;
  return (
    <div className="inspector-body">
      <header className="insp-head">
        <div className="endpoints">
          <button type="button" className="endpoint" onClick={() => from && navigateToElement(from.id)}>
            {from && <KindIcon kind={from.kind} size={14} />}
            <span>{from?.name}</span>
          </button>
          <ArrowRight size={14} strokeWidth={1.7} className="endpoint-arrow" aria-label="to" />
          <button type="button" className="endpoint" onClick={() => to && navigateToElement(to.id)}>
            {to && <KindIcon kind={to.kind} size={14} />}
            <span>{to?.name}</span>
          </button>
        </div>
        <p className="insp-note">{relations.length} relations between parts of these two are drawn as one thread here.</p>
      </header>
      <Section label="Underlying relations">
        <ul className="rel-list">
          {relations.map((r) => {
            const f = index.byId.get(r.from);
            const t = index.byId.get(r.to);
            return (
              <li key={r.id} className="rel-row-wrap">
                <button
                  type="button"
                  className={cx('rel-row', r.status === 'planned' && 'is-planned')}
                  onClick={() => setState({ selection: { elementIds: [], relationIds: [r.id], edgeKey } })}
                >
                  <span className="rel-text">
                    <span className="rel-name">{f?.name}</span> <span className="rel-verb">{r.label || RELATION_VERB[r.kind]}</span> <span className="rel-name">{t?.name}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Section>
    </div>
  );
}
