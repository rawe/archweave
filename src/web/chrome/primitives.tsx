import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../lib/dom.ts';

type Side = 'top' | 'bottom' | 'left' | 'right';

interface TipState {
  rect: DOMRect;
  label: string;
  keys?: string;
  side: Side;
}

/** Hover and focus tooltip, rendered in a portal so floating chrome never clips it. */
export function Tip({ label, keys, side = 'bottom', children }: { label: string; keys?: string; side?: Side; children: ReactElement<Record<string, unknown>> }) {
  const [tip, setTip] = useState<TipState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = (el: HTMLElement, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setTip({ rect: el.getBoundingClientRect(), label, keys, side }), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setTip(null);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const props = children.props as Record<string, (e: Event) => void>;
  const child = cloneElement(children, {
    onPointerEnter: (e: PointerEvent) => {
      props.onPointerEnter?.(e);
      if (e.pointerType === 'mouse') show(e.currentTarget as HTMLElement, 450);
    },
    onPointerLeave: (e: PointerEvent) => {
      props.onPointerLeave?.(e);
      hide();
    },
    onFocus: (e: FocusEvent) => {
      props.onFocus?.(e);
      if ((e.currentTarget as HTMLElement).matches(':focus-visible')) show(e.currentTarget as HTMLElement, 150);
    },
    onBlur: (e: FocusEvent) => {
      props.onBlur?.(e);
      hide();
    },
    onPointerDown: (e: PointerEvent) => {
      props.onPointerDown?.(e);
      hide();
    },
  });
  return (
    <>
      {child}
      {tip && createPortal(<TipBubble {...tip} />, document.body)}
    </>
  );
}

function TipBubble({ rect, label, keys, side }: TipState) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 8;
    let left = rect.left + rect.width / 2 - w / 2;
    let top = side === 'top' ? rect.top - h - gap : rect.bottom + gap;
    if (side === 'left') {
      left = rect.left - w - gap;
      top = rect.top + rect.height / 2 - h / 2;
    } else if (side === 'right') {
      left = rect.right + gap;
      top = rect.top + rect.height / 2 - h / 2;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    setPos({ left, top });
  }, [rect, side]);
  return (
    <div ref={ref} className="tip" role="tooltip" style={pos ?? { left: -9999, top: -9999 }}>
      {label}
      {keys && <Keys keys={keys} />}
    </div>
  );
}

export function Keys({ keys }: { keys: string }) {
  return (
    <span className="keys">
      {keys.split(' ').map((k, i) => (
        <kbd key={i}>{k}</kbd>
      ))}
    </span>
  );
}

export function IconButton({
  icon: Icon,
  label,
  keys,
  onClick,
  active,
  side = 'bottom',
  className,
  size = 16,
  disabled,
  children,
  buttonRef,
  ...rest
}: {
  icon: LucideIcon;
  label: string;
  keys?: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  side?: Side;
  className?: string;
  size?: number;
  disabled?: boolean;
  children?: ReactNode;
  buttonRef?: RefObject<HTMLButtonElement | null>;
  'aria-expanded'?: boolean;
  'aria-haspopup'?: 'menu' | 'dialog' | 'listbox' | true;
  'aria-pressed'?: boolean;
}) {
  return (
    <Tip label={label} keys={keys} side={side}>
      <button
        ref={buttonRef}
        type="button"
        className={cx('icon-btn', active && 'is-active', className)}
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
        {...rest}
      >
        <Icon size={size} strokeWidth={1.7} aria-hidden />
        {children}
      </button>
    </Tip>
  );
}

/** Closes on outside pointer down or Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, onClose: () => void, ignore?: RefObject<HTMLElement | null>) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || ignore?.current?.contains(t)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, ref, ignore]);
}

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  keys?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** A small floating menu at fixed screen coordinates or anchored to an element. */
export function Menu({
  items,
  at,
  anchor,
  onClose,
  align = 'start',
}: {
  items: (MenuItem | 'sep')[];
  at?: { x: number; y: number };
  anchor?: RefObject<HTMLElement | null>;
  onClose: () => void;
  align?: 'start' | 'end';
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  useDismiss(ref, true, onClose, anchor);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = at?.x ?? 0;
    let top = at?.y ?? 0;
    if (anchor?.current) {
      const r = anchor.current.getBoundingClientRect();
      left = align === 'end' ? r.right - w : r.left;
      top = r.bottom + 6;
      if (top + h > window.innerHeight - 8) top = r.top - h - 6;
    }
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    setPos({ left, top });
    el.focus();
  }, [at, anchor, align]);
  const actionable = items.map((it, i) => (it !== 'sep' && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = actionable.indexOf(active);
      const next = e.key === 'ArrowDown' ? actionable[(at + 1) % actionable.length] : actionable[(at - 1 + actionable.length) % actionable.length];
      setActive(next ?? -1);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      const it = items[active];
      if (it && it !== 'sep') {
        onClose();
        it.onSelect();
      }
    }
  };
  return createPortal(
    <div ref={ref} className="menu" role="menu" tabIndex={-1} style={pos ?? { left: -9999, top: -9999 }} onKeyDown={onKeyDown}>
      {items.map((it, i) =>
        it === 'sep' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={cx('menu-item', it.danger && 'is-danger', i === active && 'is-active')}
            disabled={it.disabled}
            onPointerEnter={() => setActive(i)}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.icon && <it.icon size={15} strokeWidth={1.7} aria-hidden />}
            <span className="menu-label">{it.label}</span>
            {it.keys && <Keys keys={it.keys} />}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useToggle(initial = false): [boolean, () => void, (v: boolean) => void] {
  const [v, setV] = useState(initial);
  const toggle = useCallback(() => setV((x) => !x), []);
  return [v, toggle, setV];
}
