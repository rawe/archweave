import { useRef, useState } from 'react';
import { GripVertical, Link2, Plus, Unlink, X } from 'lucide-react';
import type { Element, Field } from '../../shared/model.ts';
import { Picker } from '../chrome/Picker.tsx';
import { Tip } from '../chrome/primitives.tsx';
import { commit, navigateToElement } from '../state/store.ts';
import { scopePath, type ModelIndex } from '../state/selectors.ts';
import { cx } from '../lib/dom.ts';
import { fieldLinkTargets } from '../lib/fieldLinks.ts';
import { KindIcon } from '../lib/kinds.tsx';
import { InlineText, Section } from './fields.tsx';

export function FieldsEditor({ el, index }: { el: Element; index: ModelIndex }) {
  const fields = el.fields;
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null);
  const [newName, setNewName] = useState('');
  const newRef = useRef<HTMLInputElement>(null);

  // Without a summary the server describes the edit, and merges quick field edits into one journal entry.
  const save = (next: Field[]) => void commit({ elements: [{ id: el.id, fields: next }] });
  const update = (i: number, patch: Partial<Field>) => {
    const next = fields.map((f, j) => (j === i ? { ...f, ...patch } : f));
    for (const f of next) for (const k of Object.keys(f) as (keyof Field)[]) if (f[k] === undefined) delete f[k];
    save(next);
  };
  const add = () => {
    const name = newName.trim();
    if (!name) return;
    setNewName('');
    save([...fields, { name, type: '' }]);
    requestAnimationFrame(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>('.field-row .field-type');
      inputs[inputs.length - 1]?.focus();
    });
  };

  return (
    <Section label="Fields" className="fields">
      <ul className="field-list" onDragLeave={(e) => e.currentTarget === e.target && setDrag((d) => (d ? { ...d, over: d.from } : d))}>
        {fields.map((f, i) => (
          <FieldRow
            key={`${i}-${f.name}`}
            structureId={el.id}
            field={f}
            index={index}
            dragging={drag?.from === i}
            dropBefore={!!drag && drag.over === i && drag.from > i}
            dropAfter={!!drag && drag.over === i && drag.from < i}
            onDragStart={() => setDrag({ from: i, over: i })}
            onDragOver={() => setDrag((d) => (d && d.over !== i ? { ...d, over: i } : d))}
            onDrop={() => {
              if (!drag || drag.from === i) return setDrag(null);
              const next = [...fields];
              const [moved] = next.splice(drag.from, 1);
              next.splice(i, 0, moved!);
              setDrag(null);
              save(next);
            }}
            onDragEnd={() => setDrag(null)}
            onChange={(patch) => update(i, patch)}
            onRemove={() => save(fields.filter((_, j) => j !== i))}
          />
        ))}
        <li className="field-row is-new">
          <Plus size={13} strokeWidth={1.8} className="field-grip" aria-hidden />
          <input
            ref={newRef}
            className="inline-text field-name"
            value={newName}
            placeholder="Add field"
            aria-label="New field name"
            onChange={(e) => setNewName(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setNewName('');
                newRef.current?.blur();
              }
            }}
          />
        </li>
      </ul>
    </Section>
  );
}

function FieldRow({
  structureId,
  field,
  index,
  dragging,
  dropBefore,
  dropAfter,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onChange,
  onRemove,
}: {
  structureId: string;
  field: Field;
  index: ModelIndex;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onChange: (patch: Partial<Field>) => void;
  onRemove: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const linkRef = useRef<HTMLButtonElement>(null);
  const target = field.ref ? index.byId.get(field.ref) : undefined;
  const [grabbed, setGrabbed] = useState(false);
  return (
    <li
      className={cx('field-row', dragging && 'is-dragging', dropBefore && 'drop-before', dropAfter && 'drop-after', (field.type.length > 22 || field.name.length > 24) && 'is-stacked')}
      draggable={grabbed}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', field.name);
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      onDragEnd={() => {
        setGrabbed(false);
        onDragEnd();
      }}
    >
      <span className="field-grip" onPointerDown={() => setGrabbed(true)} onPointerUp={() => setGrabbed(false)} aria-hidden title="Drag to reorder">
        <GripVertical size={13} strokeWidth={1.6} />
      </span>
      <InlineText className="field-name" value={field.name} label="Field name" allowEmpty={false} onCommit={(name) => onChange({ name })} />
      <Tip label={field.optional ? 'Optional. Click to make required' : 'Required. Click to make optional'} side="top">
        <button type="button" className={cx('field-opt', field.optional && 'is-on')} aria-pressed={!!field.optional} onClick={() => onChange({ optional: field.optional ? undefined : true })}>
          ?
        </button>
      </Tip>
      <InlineText className="field-type" mono value={field.type} placeholder="type" label={`Type of ${field.name}`} onCommit={(type) => onChange({ type })} />
      {target ? (
        <button type="button" className="field-ref" onClick={() => navigateToElement(target.id)} title={`Go to ${target.name}`}>
          <Link2 size={12} strokeWidth={1.8} aria-hidden />
          {target.name}
        </button>
      ) : null}
      <span className="field-actions">
        <Tip label={target ? 'Change linked structure' : 'Link to a structure'} side="top">
          <button ref={linkRef} type="button" className="row-remove" aria-label="Link to a structure" onClick={() => setPicking(true)}>
            <Link2 size={13} strokeWidth={1.8} />
          </button>
        </Tip>
        {target && (
          <Tip label="Unlink" side="top">
            <button type="button" className="row-remove" aria-label="Unlink" onClick={() => onChange({ ref: undefined })}>
              <Unlink size={13} strokeWidth={1.8} />
            </button>
          </Tip>
        )}
        <Tip label="Remove field" side="top">
          <button type="button" className="row-remove" aria-label={`Remove field ${field.name}`} onClick={onRemove}>
            <X size={13} strokeWidth={1.8} />
          </button>
        </Tip>
      </span>
      {picking && (
        <Picker
          anchor={linkRef}
          placeholder="Link to structure"
          items={fieldLinkTargets(index.data, structureId).map((d) => ({ id: d.id, label: d.name, detail: scopePath(d, index), icon: <KindIcon kind="data" size={13} /> }))}
          onClose={() => setPicking(false)}
          onPick={(item) => onChange({ ref: item.id, type: field.type || item.label })}
        />
      )}
    </li>
  );
}
