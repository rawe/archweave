import { useRef, useState } from 'react';
import { FileCode, Plus, X } from 'lucide-react';
import type { CodeRef, StaleLink } from '../../shared/model.ts';
import { api } from '../api.ts';
import { Picker, type PickItem } from '../chrome/Picker.tsx';
import { Tip } from '../chrome/primitives.tsx';
import { openCode, useStore } from '../state/store.ts';
import { cx } from '../lib/dom.ts';
import { dirName, fileName, lineRange } from '../lib/format.ts';
import { Section } from './fields.tsx';

const REASON: Record<StaleLink['reason'], string> = {
  'missing-file': 'File no longer exists',
  'line-out-of-range': 'Lines are past the end of the file',
  'symbol-not-found': 'Symbol not found in the file',
};

function sameRef(a: CodeRef, b: CodeRef) {
  return a.path === b.path && a.symbol === b.symbol && a.startLine === b.startLine && a.endLine === b.endLine;
}

export function CodeRefs({ ownerId, refs, onChange }: { ownerId: string; refs: CodeRef[]; onChange: (refs: CodeRef[]) => void }) {
  const stale = useStore((s) => s.stale);
  const current = useStore((s) => s.code);
  const [picking, setPicking] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const load = async (q: string): Promise<PickItem[]> => {
    const files = await api.codeFiles(q, 40);
    return files.map((path) => ({ id: path, label: fileName(path), detail: dirName(path), mono: true }));
  };

  return (
    <Section
      label="Code"
      action={
        <button ref={addRef} type="button" className="section-action" onClick={() => setPicking(true)}>
          <Plus size={13} strokeWidth={1.8} aria-hidden />
          Link code
        </button>
      }
    >
      {refs.length > 0 && (
        <ul className="code-refs">
          {refs.map((ref, i) => {
            const problem = stale.find((s) => s.ownerId === ownerId && sameRef(s.ref, ref));
            const open = current?.path === ref.path && current.startLine === ref.startLine;
            return (
              <li key={`${ref.path}-${ref.symbol}-${ref.startLine}-${i}`} className={cx('code-ref', problem && 'is-stale', open && 'is-open')}>
                <button
                  type="button"
                  className="code-ref-main"
                  onClick={() => openCode({ path: ref.path, startLine: ref.startLine, endLine: ref.endLine, ownerId })}
                >
                  <FileCode size={14} strokeWidth={1.6} aria-hidden className="code-ref-icon" />
                  <span className="code-ref-text">
                    <span className="code-ref-path mono" title={ref.path}>
                      <span className="code-ref-dir">{dirName(ref.path) && `${dirName(ref.path)}/`}</span>
                      {fileName(ref.path)}
                    </span>
                    {(ref.symbol || ref.startLine) && (
                      <span className="code-ref-meta mono">
                        {ref.symbol}
                        {ref.symbol && ref.startLine ? ' · ' : ''}
                        {ref.startLine ? `L${lineRange(ref.startLine, ref.endLine)}` : ''}
                      </span>
                    )}
                    {problem && <span className="code-ref-problem">{REASON[problem.reason]}</span>}
                    {ref.note && !problem && <span className="code-ref-note">{ref.note}</span>}
                  </span>
                </button>
                <Tip label="Remove link" side="left">
                  <button type="button" className="row-remove" aria-label="Remove link" onClick={() => onChange(refs.filter((_, j) => j !== i))}>
                    <X size={13} strokeWidth={1.8} />
                  </button>
                </Tip>
              </li>
            );
          })}
        </ul>
      )}
      {picking && (
        <Picker
          anchor={addRef}
          load={load}
          placeholder="Find a file"
          emptyText="No matching files"
          onClose={() => setPicking(false)}
          onPick={(item) => {
            if (!refs.some((r) => r.path === item.id && !r.startLine && !r.symbol)) onChange([...refs, { path: item.id }]);
            openCode({ path: item.id, ownerId });
          }}
        />
      )}
    </Section>
  );
}
