import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { cx } from '../lib/dom.ts';

/**
 * Text that edits in place. Holds its own draft while focused so a snapshot
 * arriving mid-edit never overwrites what the human is typing.
 */
export function InlineText({
  value,
  onCommit,
  placeholder,
  className,
  mono,
  label,
  autoFocus,
  onFocused,
  allowEmpty = true,
  maxLength,
  multiline,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  className?: string;
  mono?: boolean;
  label: string;
  autoFocus?: boolean;
  onFocused?: () => void;
  allowEmpty?: boolean;
  maxLength?: number;
  /** Wraps like text and grows with it; Enter still commits. */
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!multiline || !el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft, multiline]);

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
      onFocused?.();
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  const commit = () => {
    editing.current = false;
    const next = draft.trim();
    if (next === value.trim()) return setDraft(value);
    if (!next && !allowEmpty) return setDraft(value);
    onCommit(next);
  };

  const Tag = multiline ? 'textarea' : 'input';
  return (
    <Tag
      ref={ref}
      className={cx('inline-text', multiline && 'is-multiline', mono && 'mono', className)}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      maxLength={maxLength}
      spellCheck={!mono}
      rows={multiline ? 1 : undefined}
      onFocus={() => (editing.current = true)}
      onChange={(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(multiline ? e.target.value.replace(/\n/g, ' ') : e.target.value)}
      onBlur={commit}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          editing.current = false;
          setDraft(value);
          requestAnimationFrame(() => ref.current?.blur());
        }
      }}
    />
  );
}

/** A textarea that grows with its content; commits on blur or Mod+Enter. */
export function GrowingText({
  value,
  onCommit,
  placeholder,
  className,
  mono,
  label,
  autoFocus,
  onDone,
}: {
  value: string;
  onCommit: (value: string) => void;
  placeholder?: string;
  className?: string;
  mono?: boolean;
  label: string;
  autoFocus?: boolean;
  onDone?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [draft]);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      const len = ref.current?.value.length ?? 0;
      ref.current?.setSelectionRange(len, len);
    }
  }, [autoFocus]);
  const commit = () => {
    editing.current = false;
    if (draft !== value) onCommit(draft);
    onDone?.();
  };
  return (
    <textarea
      ref={ref}
      className={cx('growing-text', mono && 'mono', className)}
      value={draft}
      rows={1}
      placeholder={placeholder}
      aria-label={label}
      spellCheck={!mono}
      onFocus={() => (editing.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          ref.current?.blur();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          editing.current = false;
          setDraft(value);
          requestAnimationFrame(() => {
            ref.current?.blur();
          });
        } else if (mono && e.key === 'Tab' && !e.shiftKey) {
          e.preventDefault();
          const el = e.currentTarget;
          const { selectionStart: a, selectionEnd: b } = el;
          setDraft(draft.slice(0, a) + '  ' + draft.slice(b));
          requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
        }
      }}
    />
  );
}

marked.setOptions({ gfm: true, breaks: false });

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false }) as string), [source]);
  return <div className={cx('markdown', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Rendered markdown that turns into a textarea on click. */
export function MarkdownField({ value, onCommit, placeholder, label }: { value: string; onCommit: (v: string) => void; placeholder: string; label: string }) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return <GrowingText value={value} onCommit={onCommit} label={label} placeholder={placeholder} autoFocus onDone={() => setEditing(false)} className="md-editor" />;
  if (!value.trim())
    return (
      <button type="button" className="placeholder-btn" onClick={() => setEditing(true)}>
        {placeholder}
      </button>
    );
  return (
    <div
      className="md-view"
      role="button"
      tabIndex={0}
      aria-label={`${label}. Click to edit`}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          setEditing(true);
        }
      }}
    >
      <Markdown source={value} />
    </div>
  );
}

export function Section({ label, children, action, className }: { label: string; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section className={cx('section', className)}>
      <div className="section-head">
        <h3 className="section-label">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="mini-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={cx('mini-seg-btn', `is-${o.value}`, value === o.value && 'is-active')}
          onClick={() => value !== o.value && onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
