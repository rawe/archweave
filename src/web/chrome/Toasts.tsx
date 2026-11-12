import { ArrowRight, X } from 'lucide-react';
import { dismissToast, useStore } from '../state/store.ts';
import { cx } from '../lib/dom.ts';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `tone-${t.tone}`, t.action && 'is-actionable')}>
          {t.tone === 'agent' && <span className="toast-dot" aria-hidden />}
          {t.action ? (
            <button
              type="button"
              className="toast-body"
              onClick={() => {
                t.action?.();
                dismissToast(t.id);
              }}
            >
              <span className="toast-text">{t.text}</span>
              <span className="toast-action">
                {t.actionLabel ?? 'Show'}
                <ArrowRight size={13} strokeWidth={1.8} aria-hidden />
              </span>
            </button>
          ) : (
            <span className="toast-body">
              <span className="toast-text">{t.text}</span>
            </span>
          )}
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <X size={13} strokeWidth={1.8} />
          </button>
        </div>
      ))}
    </div>
  );
}
