import type { ReactNode } from 'react';
import { PanelLeftClose, PanelLeft } from 'lucide-react';
import { cx } from '../lib/dom.ts';
import { IconButton } from './primitives.tsx';

/** The slim list rail of the Data and Flows perspectives. */
export function Rail({
  open,
  onToggle,
  label,
  filter,
  onFilter,
  placeholder,
  children,
  footer,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  filter: string;
  onFilter: (v: string) => void;
  placeholder: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open)
    return (
      <div className="rail-collapsed">
        <IconButton icon={PanelLeft} label={`Show ${label.toLowerCase()}`} side="right" onClick={onToggle} />
      </div>
    );
  return (
    <nav className={cx('rail')} aria-label={label}>
      <div className="rail-top">
        <input
          className="rail-filter"
          value={filter}
          placeholder={placeholder}
          aria-label={`Filter ${label.toLowerCase()}`}
          onChange={(e) => onFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onFilter('');
              (e.target as HTMLElement).blur();
            }
          }}
        />
        <IconButton icon={PanelLeftClose} label="Hide list" side="right" size={15} onClick={onToggle} />
      </div>
      <div className="rail-list">{children}</div>
      {footer && <div className="rail-foot">{footer}</div>}
    </nav>
  );
}
