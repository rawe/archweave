import { useEffect, useRef } from 'react';
import { create } from 'zustand';

interface Ask {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirm = create<{ ask: Ask | null }>(() => ({ ask: null }));

export function confirmAction(opts: Omit<Ask, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ ask: { ...opts, resolve } }));
}

export function ConfirmHost() {
  const ask = useConfirm((s) => s.ask);
  const ok = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!ask) return;
    ok.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ask]);
  if (!ask) return null;
  function done(result: boolean) {
    ask?.resolve(result);
    useConfirm.setState({ ask: null });
  }
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && done(false)}>
      <div className="dialog dialog-confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title" className="dialog-title">
          {ask.title}
        </h2>
        {ask.body && <p className="dialog-body">{ask.body}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => done(false)}>
            Cancel
          </button>
          <button ref={ok} type="button" className={ask.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => done(true)}>
            {ask.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
