import { useRef, useState } from 'react';
import { ArrowUpRight, ChevronDown, ClipboardCopy, CornerLeftUp, FolderInput, Trash } from 'lucide-react';
import { ELEMENT_KINDS, type Element, type ElementKind, type ElementPatch, type Status } from '../../shared/model.ts';
import { descendantsOf } from '../../shared/projection.ts';
import { Menu, Tip } from '../chrome/primitives.tsx';
import { Picker } from '../chrome/Picker.tsx';
import { deleteSelection, reparent } from '../state/actions.ts';
import { commit, enterScope, getState, toast } from '../state/store.ts';
import { scopePath, type ModelIndex } from '../state/selectors.ts';
import { copyText } from '../lib/dom.ts';
import { KindIcon, KIND_LABEL } from '../lib/kinds.tsx';
import { PROMPTS } from '../lib/prompts.ts';
import { CodeRefs } from './CodeRefs.tsx';
import { FieldsEditor } from './FieldsEditor.tsx';
import { GrowingText, InlineText, MarkdownField, Section, Segmented } from './fields.tsx';
import { Notes, Relations, TouchedData, UsedBy } from './sections.tsx';

export const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: 'planned', label: 'Planned' },
  { value: 'built', label: 'Built' },
  { value: 'deprecated', label: 'Deprecated' },
];

export function ElementInspector({ el, index }: { el: Element; index: ModelIndex }) {
  const patch = (p: Omit<ElementPatch, 'id'>, summary = `Edited ${el.name}`) => void commit({ summary, elements: [{ id: el.id, ...p }] });
  const [kindMenu, setKindMenu] = useState(false);
  const kindRef = useRef<HTMLButtonElement>(null);
  const isData = el.kind === 'data';
  const childCount = (index.children.get(el.id) ?? []).filter((c) => c.kind !== 'data').length;
  const path = scopePath(el, index);

  return (
    <div className="inspector-body">
      <header className="insp-head">
        <div className="insp-title-row">
          <Tip label={`${KIND_LABEL[el.kind]}. Change kind`}>
            <button ref={kindRef} type="button" className="insp-kind" aria-label={`Kind: ${KIND_LABEL[el.kind]}`} onClick={() => setKindMenu(true)} disabled={isData}>
              <KindIcon kind={el.kind} size={17} />
            </button>
          </Tip>
          <InlineText
            className="insp-name"
            value={el.name}
            label="Name"
            allowEmpty={false}
            maxLength={120}
            onCommit={(name) => patch({ name }, `Renamed ${el.name} to ${name}`)}
          />
        </div>
        {path && <div className="insp-path">{path}</div>}
        <div className="insp-meta">
          <Segmented label="Status" value={el.status} options={STATUS_OPTIONS} onChange={(status) => patch({ status }, `Marked ${el.name} ${status}`)} />
          <InlineText
            className="insp-tech"
            value={(isData ? el.format : el.technology) ?? ''}
            placeholder={isData ? 'Format' : 'Technology'}
            label={isData ? 'Format' : 'Technology'}
            onCommit={(v) => (isData ? patch({ format: v }) : patch({ technology: v }))}
          />
        </div>
        {!isData && childCount > 0 && el.kind !== 'data' && (
          <button type="button" className="insp-open" onClick={() => enterScope(el.id)}>
            Open
            <span className="muted">{childCount} inside</span>
            <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden />
          </button>
        )}
      </header>

      <InlineText
        multiline
        className="insp-summary"
        value={el.summary}
        placeholder="One sentence about what it is responsible for"
        label="Summary"
        maxLength={280}
        onCommit={(summary) => patch({ summary })}
      />
      <div className="insp-desc">
        <MarkdownField value={el.description} onCommit={(description) => patch({ description })} placeholder="Add a description" label="Description" />
      </div>

      <CodeRefs ownerId={el.id} refs={el.codeRefs} onChange={(codeRefs) => patch({ codeRefs }, `Updated code links of ${el.name}`)} />

      {isData ? (
        <>
          <FieldsEditor el={el} index={index} />
          <Section label="Example" className="example">
            <GrowingText
              mono
              className="code-input"
              value={el.example ?? ''}
              placeholder={el.format === 'xml' ? '<order id="…">' : '{ "id": "…" }'}
              label="Example payload"
              onCommit={(example) => patch({ example }, `Edited the example of ${el.name}`)}
            />
          </Section>
          <UsedBy el={el} index={index} />
        </>
      ) : (
        <TouchedData el={el} index={index} />
      )}

      <Relations el={el} index={index} />
      <Notes el={el} />
      <Footer el={el} index={index} />

      {kindMenu && (
        <Menu
          anchor={kindRef}
          onClose={() => setKindMenu(false)}
          items={ELEMENT_KINDS.filter((k) => k !== 'data').map((k: ElementKind) => ({
            label: KIND_LABEL[k],
            onSelect: () => k !== el.kind && patch({ kind: k }, `Made ${el.name} a ${KIND_LABEL[k].toLowerCase()}`),
          }))}
        />
      )}
    </div>
  );
}

function Footer({ el, index }: { el: Element; index: ModelIndex }) {
  const [promptMenu, setPromptMenu] = useState(false);
  const [moving, setMoving] = useState(false);
  const promptRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const isData = el.kind === 'data';
  const excluded = new Set([el.id, ...descendantsOf(el.id, getState().model.elements).map((d) => d.id)]);
  const parents = [...index.byId.values()].filter((p) => p.kind !== 'data' && !excluded.has(p.id) && p.id !== el.parentId);

  return (
    <footer className="insp-foot">
      <button ref={promptRef} type="button" className="foot-btn" onClick={() => setPromptMenu(true)} aria-haspopup="menu">
        <ClipboardCopy size={14} strokeWidth={1.7} aria-hidden />
        Copy prompt
        <ChevronDown size={13} strokeWidth={1.7} aria-hidden />
      </button>
      <button ref={moveRef} type="button" className="foot-btn" onClick={() => setMoving(true)}>
        <FolderInput size={14} strokeWidth={1.7} aria-hidden />
        {isData ? 'Owner…' : 'Move to…'}
      </button>
      <span className="foot-spacer" />
      <Tip label="Delete" keys="⌫" side="top">
        <button type="button" className="foot-btn is-danger" aria-label={`Delete ${el.name}`} onClick={() => void deleteSelection()}>
          <Trash size={14} strokeWidth={1.7} />
        </button>
      </Tip>
      {promptMenu && (
        <Menu
          anchor={promptRef}
          onClose={() => setPromptMenu(false)}
          items={PROMPTS.map((p) => ({
            label: p.label,
            onSelect: () => void copyText(p.build(el)).then(() => toast({ tone: 'info', text: `Copied the ${p.label.replace('…', '').toLowerCase()} prompt. Paste it to your agent.` })),
          }))}
        />
      )}
      {moving && (
        <Picker
          anchor={moveRef}
          placeholder={isData ? 'Owned by…' : 'Move into…'}
          items={[
            ...(el.parentId ? [{ id: '__root', label: isData ? 'No owner' : 'Top level', icon: <CornerLeftUp size={13} strokeWidth={1.7} /> }] : []),
            ...parents.map((p) => ({ id: p.id, label: p.name, detail: scopePath(p, index), icon: <KindIcon kind={p.kind} size={13} /> })),
          ]}
          onClose={() => setMoving(false)}
          onPick={(item) => {
            const target = item.id === '__root' ? null : item.id;
            if (isData) void commit({ summary: `Changed the owner of ${el.name}`, elements: [{ id: el.id, parentId: target }] });
            else reparent([el.id], target, `structure:${el.parentId ?? 'root'}`);
          }}
        />
      )}
    </footer>
  );
}
