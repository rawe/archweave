import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { fuzzyFilter } from '../lib/fuzzy.ts';
import { cx } from '../lib/dom.ts';
import { useDismiss } from './primitives.tsx';

export interface PickItem {
  id: string;
  label: string;
  detail?: string;
  icon?: ReactNode;
  mono?: boolean;
}

/** A small anchored search list: type to filter, arrows to move, Enter to pick. */
export function Picker({
  anchor,
  items,
  load,
  onPick,
  onClose,
  placeholder,
  emptyText = 'Nothing matches',
  header,
}: {
  anchor: RefObject<HTMLElement | null>;
  items?: PickItem[];
  load?: (query: string) => Promise<PickItem[]>;
  onPick: (item: PickItem) => void;
  onClose: () => void;
  placeholder: string;
  emptyText?: string;
  header?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [loaded, setLoaded] = useState<PickItem[]>([]);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useDismiss(ref, true, onClose, anchor);

  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(260, Math.min(340, r.width));
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = r.bottom + 6;
    const top = below + 300 > window.innerHeight ? Math.max(8, r.top - 306) : below;
    setPos({ left, top, width });
  }, [anchor]);

  useEffect(() => {
    if (!load) return;
    let live = true;
    const t = setTimeout(() => void load(query).then((r) => live && setLoaded(r), () => live && setLoaded([])), 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, load]);

  const list = load ? loaded : fuzzyFilter(items ?? [], query, (i) => `${i.label} ${i.detail ?? ''}`, 60);
  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    ref.current?.querySelector('.pick-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return createPortal(
    <div ref={ref} className="popover picker" style={pos ?? { left: -9999, top: -9999 }} role="dialog" aria-label={placeholder}>
      <input
        className="picker-input"
        autoFocus
        value={query}
        placeholder={placeholder}
        onChange={(e) => setQuery(e.target.value)}
        role="combobox"
        aria-expanded
        aria-controls="picker-list"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(list.length - 1, a + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const item = list[active];
            if (item) {
              onPick(item);
              onClose();
            }
          }
        }}
      />
      {header}
      <ul className="picker-list" id="picker-list" role="listbox">
        {list.map((item, i) => (
          <li key={item.id} role="option" aria-selected={i === active}>
            <button
              type="button"
              className={cx('pick-item', i === active && 'is-active')}
              onPointerEnter={() => setActive(i)}
              onClick={() => {
                onPick(item);
                onClose();
              }}
            >
              {item.icon}
              <span className={cx('pick-label', item.mono && 'mono')}>{item.label}</span>
              {item.detail && <span className="pick-detail">{item.detail}</span>}
            </button>
          </li>
        ))}
        {!list.length && <li className="pick-empty">{emptyText}</li>}
      </ul>
    </div>,
    document.body,
  );
}
