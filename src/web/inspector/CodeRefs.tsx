import { useRef, useState } from 'react';
import { FileCode, Plus, X } from 'lucide-react';
import type { CodeRef } from '../../shared/model.ts';
import { api } from '../api.ts';
import { Picker, type PickItem } from '../chrome/Picker.tsx';
import { Tip } from '../chrome/primitives.tsx';
import { keepLink, linkProblem, reanchorLink } from '../state/codeLinks.ts';
import { openCode, useStore } from '../state/store.ts';
import { staleFor, type RefOwner } from '../lib/codeRefs.ts';
import { cx } from '../lib/dom.ts';
import { dirName, fileName, lineRange, linesLabel } from '../lib/format.ts';
import { Section } from './fields.tsx';

/**
 * The Code section of an element, relation or flow step. `onChange` gets the full list; refs the
 * human did not touch are passed back exactly as read (seal included), so their seals hold.
 */
export function CodeRefs({ owner, refs, onChange }: { owner: RefOwner; refs: CodeRef[]; onChange: (refs: CodeRef[]) => void }) {
  const ownerId = owner.id;
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
            const problem = staleFor(stale, owner, ref);
            const open = current?.path === ref.path && current.startLine === ref.startLine;
            const follow = () => openCode({ path: ref.path, startLine: ref.startLine, endLine: ref.endLine, ownerId, ...(problem ? { link: problem } : {}) });
            const suggestion = problem?.suggestion;
            const target = suggestion && linesLabel(suggestion.startLine, suggestion.endLine);
            return (
              <li key={`${ref.path}-${ref.symbol}-${ref.startLine}-${i}`} className={cx('code-ref', problem && 'is-stale', open && 'is-open')}>
                <button type="button" className="code-ref-main" onClick={follow}>
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
                    {problem && <span className="code-ref-problem">{linkProblem(problem)}</span>}
                    {ref.note && !problem && <span className="code-ref-note">{ref.note}</span>}
                  </span>
                </button>
                <Tip label="Remove link" side="left">
                  <button type="button" className="row-remove" aria-label="Remove link" onClick={() => onChange(refs.filter((_, j) => j !== i))}>
                    <X size={13} strokeWidth={1.8} />
                  </button>
                </Tip>
                {problem?.reason === 'moved' && suggestion && (
                  <div className="code-ref-fixes">
                    <button type="button" className="code-ref-fix is-main" onClick={() => reanchorLink(problem, suggestion)}>
                      Re-anchor
                    </button>
                  </div>
                )}
                {problem?.reason === 'changed' && (
                  <div className="code-ref-fixes">
                    <button type="button" className="code-ref-fix" onClick={follow}>
                      Open
                    </button>
                    <button type="button" className="code-ref-fix" onClick={() => keepLink(problem)}>
                      Still right
                    </button>
                    {suggestion && (
                      <button type="button" className="code-ref-fix" onClick={() => reanchorLink(problem, suggestion)}>
                        Use {target}
                      </button>
                    )}
                  </div>
                )}
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
