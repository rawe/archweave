import { useEffect, useRef, useState } from 'react';
import type { ElementKind } from '../../shared/model.ts';
import { KindIcon, KIND_LABEL } from '../lib/kinds.tsx';
import { Keys } from '../chrome/primitives.tsx';

/** Inline "name it, pick a kind, Enter" creator that appears where the pointer is. */
export function Composer({
  at,
  kinds,
  defaultKind,
  onCreate,
  onCancel,
  placeholder = 'Name',
}: {
  at: { x: number; y: number };
  kinds: ElementKind[];
  defaultKind: ElementKind;
  onCreate: (name: string, kind: ElementKind) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const [name, setName] = useState('');
  const [kindIndex, setKindIndex] = useState(Math.max(0, kinds.indexOf(defaultKind)));
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  const kind = kinds[kindIndex]!;

  useEffect(() => input.current?.focus(), []);

  const finish = (create: boolean) => {
    if (done.current) return;
    done.current = true;
    if (create && name.trim()) onCreate(name.trim(), kind);
    else onCancel();
  };

  return (
    <div className="composer" style={{ left: at.x, top: at.y }} onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="composer-kind"
        tabIndex={-1}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setKindIndex((i) => (i + 1) % kinds.length)}
        title="Change kind (Tab)"
      >
        <KindIcon kind={kind} size={15} />
      </button>
      <input
        ref={input}
        value={name}
        placeholder={placeholder}
        aria-label={`New ${KIND_LABEL[kind].toLowerCase()} name`}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Tab') {
            e.preventDefault();
            setKindIndex((i) => (i + (e.shiftKey ? kinds.length - 1 : 1)) % kinds.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
      />
      <span className="composer-hint">
        {KIND_LABEL[kind]}
        <Keys keys="Tab" />
      </span>
    </div>
  );
}
