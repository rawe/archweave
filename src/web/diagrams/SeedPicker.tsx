import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import type { Diagram } from '../../shared/model.ts';
import { useDismiss } from '../chrome/primitives.tsx';
import { cx } from '../lib/dom.ts';
import { fuzzyFilter } from '../lib/fuzzy.ts';
import { KindIcon } from '../lib/kinds.tsx';
import { scopePath, useIndex } from '../state/selectors.ts';
import { useStore } from '../state/store.ts';
import { seedDiagram } from './actions.ts';

/** Picks several elements to draw on a diagram, with the relations among them. */
export function SeedPicker({ anchor, diagram, onClose }: { anchor: RefObject<HTMLElement | null>; diagram: Diagram; onClose: () => void }) {
  const elements = useStore((s) => s.model.elements);
  const index = useIndex();
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useDismiss(ref, true, onClose, anchor);

  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(r.right - 320, window.innerWidth - 328)), top: r.bottom + 6 });
  }, [anchor]);

  const drawn = useMemo(() => new Set(diagram.shapes.flatMap((s) => (s.link?.type === 'element' ? [s.link.id] : []))), [diagram.shapes]);
  const all = useMemo(
    () => elements.map((e) => ({ e, path: scopePath(e, index) })).sort((a, b) => a.path.localeCompare(b.path) || a.e.name.localeCompare(b.e.name)),
    [elements, index],
  );
  const list = fuzzyFilter(all, query, (x) => `${x.e.name} ${x.path}`, 80);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    ref.current?.querySelector('.pick-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const toggle = (id: string) => {
    if (drawn.has(id)) return;
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  };
  const add = () => {
    if (!chosen.length) return;
    seedDiagram(diagram, chosen);
    onClose();
  };

  return createPortal(
    <div ref={ref} className="popover picker seed-picker" style={pos ?? { left: -9999, top: -9999 }} role="dialog" aria-label="Add elements from the model">
      <input
        className="picker-input"
        autoFocus
        value={query}
        placeholder="Elements to draw"
        aria-label="Filter elements"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(list.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) add();
            else if (list[active]) toggle(list[active].e.id);
          }
        }}
      />
      <ul className="picker-list" role="listbox" aria-multiselectable>
        {list.map(({ e, path }, i) => {
          const on = drawn.has(e.id) || chosen.includes(e.id);
          return (
            <li key={e.id} role="option" aria-selected={on} aria-disabled={drawn.has(e.id)}>
              <button
                type="button"
                className={cx('pick-item', i === active && 'is-active', drawn.has(e.id) && 'is-drawn')}
                onPointerEnter={() => setActive(i)}
                onClick={() => toggle(e.id)}
              >
                <span className={cx('seed-check', on && 'is-on')}>{on && <Check size={11} strokeWidth={2.4} />}</span>
                <KindIcon kind={e.kind} size={13} />
                <span className="pick-label">{e.name}</span>
                <span className="pick-detail">{drawn.has(e.id) ? 'on the diagram' : path}</span>
              </button>
            </li>
          );
        })}
        {!list.length && <li className="pick-empty">{elements.length ? 'Nothing matches' : 'The model has no elements yet'}</li>}
      </ul>
      <div className="seed-foot">
        <span className="muted">Relations among them are drawn too.</span>
        <button type="button" className="btn btn-primary btn-small" disabled={!chosen.length} onClick={add}>
          {chosen.length ? `Add ${chosen.length}` : 'Add'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
