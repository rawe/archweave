import { useEffect, useRef, useState } from 'react';
import { X, Trash, FolderInput } from 'lucide-react';
import { IconButton } from '../chrome/primitives.tsx';
import { Picker } from '../chrome/Picker.tsx';
import { deleteSelection, reparent, canvasKey } from '../state/actions.ts';
import { clearSelection, navigateToElement, useStore } from '../state/store.ts';
import { scopePath, useIndex } from '../state/selectors.ts';
import { cx } from '../lib/dom.ts';
import { plural } from '../lib/format.ts';
import { KindIcon } from '../lib/kinds.tsx';
import { ElementInspector } from './ElementInspector.tsx';
import { RelationInspector } from './RelationInspector.tsx';
import { StepInspector } from './StepInspector.tsx';

export function Inspector() {
  const selection = useStore((s) => s.selection);
  const perspective = useStore((s) => s.perspective);
  const flowId = useStore((s) => s.flowId);
  const stepIndex = useStore((s) => s.stepIndex);
  const flow = useStore((s) => s.model.flows.find((f) => f.id === s.flowId));
  const index = useIndex();

  let content: React.ReactNode = null;
  let key = '';
  if (perspective === 'flows' && flow && stepIndex !== null && flow.steps[stepIndex]) {
    content = <StepInspector flow={flow} stepIndex={stepIndex} index={index} />;
    key = `step-${flowId}-${stepIndex}`;
  } else if (selection.elementIds.length === 1) {
    const el = index.byId.get(selection.elementIds[0]!);
    if (el) {
      content = <ElementInspector el={el} index={index} />;
      key = el.id;
    }
  } else if (selection.elementIds.length > 1) {
    content = <MultiInspector ids={selection.elementIds} />;
    key = 'multi';
  } else if (selection.relationIds.length) {
    const rels = selection.relationIds.map((id) => index.relById.get(id)).filter((r) => !!r);
    if (rels.length) {
      content = <RelationInspector relations={rels} index={index} edgeKey={selection.edgeKey} />;
      key = `rel-${selection.relationIds.join(',')}`;
    }
  }

  // Keep the last content mounted while it slides out.
  const last = useRef<{ content: React.ReactNode; key: string } | null>(null);
  const [closing, setClosing] = useState(false);
  if (content) last.current = { content, key };
  const hasContent = !!content;
  useEffect(() => {
    if (hasContent) return setClosing(false);
    if (!last.current) return;
    setClosing(true);
    const t = setTimeout(() => {
      last.current = null;
      setClosing(false);
    }, 150);
    return () => clearTimeout(t);
  }, [hasContent]);

  const visible = content ?? last.current?.content;
  if (!visible) return null;
  return (
    <aside className={cx('inspector', closing && !content && 'is-closing')} aria-label="Inspector">
      <div className="inspector-close">
        <IconButton icon={X} label="Close" keys="Esc" side="left" onClick={clearSelection} size={15} />
      </div>
      <div className="inspector-scroll" key={content ? key : last.current?.key}>
        {visible}
      </div>
    </aside>
  );
}

function MultiInspector({ ids }: { ids: string[] }) {
  const index = useIndex();
  const scopeId = useStore((s) => s.scopeId);
  const [moving, setMoving] = useState(false);
  const moveRef = useRef<HTMLButtonElement>(null);
  const els = ids.map((id) => index.byId.get(id)).filter((e) => !!e);
  const structural = els.filter((e) => e.kind !== 'data');
  return (
    <div className="inspector-body">
      <header className="insp-head">
        <h2 className="insp-multi">{plural(els.length, 'element')} selected</h2>
      </header>
      <ul className="rel-list">
        {els.map((e) => (
          <li key={e.id} className="rel-row-wrap">
            <button type="button" className="rel-row" onClick={() => navigateToElement(e.id)}>
              <KindIcon kind={e.kind} size={13} className="rel-kind" />
              <span className="rel-text">
                <span className="rel-name">{e.name}</span>
                {e.summary && <> <span className="rel-verb">{e.summary}</span></>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <footer className="insp-foot">
        {structural.length > 0 && (
          <button ref={moveRef} type="button" className="foot-btn" onClick={() => setMoving(true)}>
            <FolderInput size={14} strokeWidth={1.7} aria-hidden />
            Move to…
          </button>
        )}
        <span className="foot-spacer" />
        <button type="button" className="foot-btn is-danger" onClick={() => void deleteSelection()}>
          <Trash size={14} strokeWidth={1.7} aria-hidden />
          Delete
        </button>
      </footer>
      {moving && (
        <Picker
          anchor={moveRef}
          placeholder="Move into…"
          items={[
            { id: '__root', label: 'Top level' },
            ...[...index.byId.values()]
              .filter((p) => p.kind !== 'data' && !ids.includes(p.id))
              .map((p) => ({ id: p.id, label: p.name, detail: scopePath(p, index), icon: <KindIcon kind={p.kind} size={13} /> })),
          ]}
          onClose={() => setMoving(false)}
          onPick={(item) => reparent(structural.map((e) => e.id), item.id === '__root' ? null : item.id, canvasKey(scopeId))}
        />
      )}
    </div>
  );
}
