import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Copy, ExternalLink, Link2, X } from 'lucide-react';
import type { CodeRef } from '../../shared/model.ts';
import { api, type CodeFile } from '../api.ts';
import { IconButton, Tip } from '../chrome/primitives.tsx';
import { closeCode, commit, getState, navigateToElement, navigateToRelation, toast, useStore } from '../state/store.ts';
import { copyText, cx } from '../lib/dom.ts';
import { lineRange } from '../lib/format.ts';
import { KindIcon } from '../lib/kinds.tsx';

const LINE_H = 20;
const HEIGHT_KEY = 'archweave.drawer';

function initialHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY));
    if (v > 120) return v;
  } catch {
    /* ignore */
  }
  return Math.round(window.innerHeight * 0.38);
}

export function CodeDrawer() {
  const code = useStore((s) => s.code);
  const [height, setHeight] = useState(initialHeight);

  useLayoutEffect(() => {
    const app = document.querySelector<HTMLElement>('.app');
    app?.style.setProperty('--drawer-h', code ? `${height}px` : '0px');
  }, [code, height]);

  if (!code) return null;
  return <Drawer key={code.path} height={height} setHeight={setHeight} />;
}

function Drawer({ height, setHeight }: { height: number; setHeight: (h: number) => void }) {
  const code = useStore((s) => s.code)!;
  const model = useStore((s) => s.model);
  const hostPath = useStore((s) => s.repo.hostPath);
  const selection = useStore((s) => s.selection);
  const perspective = useStore((s) => s.perspective);
  const stepIndex = useStore((s) => s.stepIndex);
  const flowId = useStore((s) => s.flowId);
  const [file, setFile] = useState<CodeFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<{ a: number; b: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    setFile(null);
    setError(null);
    api.codeFile(code.path).then(
      (f) => live && setFile(f),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
    };
  }, [code.path]);

  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    setLines([]);
    if (file?.content === undefined) return;
    const content = file.content;
    // highlight.js loads on first use of the drawer.
    void import('./highlight.ts').then(({ highlightLines, languageFor }) => {
      if (live) setLines(highlightLines(content, languageFor(file.path, file.language)));
    });
    return () => {
      live = false;
    };
  }, [file]);

  useLayoutEffect(() => {
    if (!lines.length || !scroller.current) return;
    const start = code.startLine ?? 1;
    scroller.current.scrollTop = Math.max(0, (start - 1) * LINE_H - scroller.current.clientHeight / 3);
  }, [lines, code.startLine, code.endLine]);

  useEffect(() => setRange(null), [code.startLine, code.endLine]);

  // Elements, relations and flow steps that link into this same file.
  const linked = useMemo(() => {
    const out: { id: string; name: string; kind?: string; type: 'element' | 'relation' }[] = [];
    for (const e of model.elements) if (e.codeRefs.some((r) => r.path === code.path)) out.push({ id: e.id, name: e.name, kind: e.kind, type: 'element' });
    for (const r of model.relations)
      if (r.codeRefs.some((c) => c.path === code.path)) {
        const a = model.elements.find((e) => e.id === r.from)?.name ?? r.from;
        const b = model.elements.find((e) => e.id === r.to)?.name ?? r.to;
        out.push({ id: r.id, name: `${a} → ${b}`, type: 'relation' });
      }
    return out;
  }, [model, code.path]);

  // Where "Link selection" would attach the range.
  const target = (() => {
    if (perspective === 'flows' && flowId && stepIndex !== null) {
      const flow = model.flows.find((f) => f.id === flowId);
      if (flow?.steps[stepIndex]) return { type: 'step' as const, name: `step ${stepIndex + 1}`, flow };
    }
    if (selection.elementIds.length === 1) {
      const el = model.elements.find((e) => e.id === selection.elementIds[0]);
      if (el) return { type: 'element' as const, name: el.name, el };
    }
    if (selection.relationIds.length === 1) {
      const rel = model.relations.find((r) => r.id === selection.relationIds[0]);
      if (rel) return { type: 'relation' as const, name: 'this relation', rel };
    }
    return null;
  })();

  const linkSelection = () => {
    if (!range || !target) return;
    const startLine = Math.min(range.a, range.b);
    const endLine = Math.max(range.a, range.b);
    const ref: CodeRef = { path: code.path, startLine, ...(endLine !== startLine ? { endLine } : {}) };
    const summary = `Linked ${code.path}:${lineRange(startLine, endLine)} to ${target.name}`;
    if (target.type === 'element') void commit({ summary, elements: [{ id: target.el.id, codeRefs: [...target.el.codeRefs.filter((r) => !(r.path === code.path && !r.startLine)), ref] }] });
    else if (target.type === 'relation') void commit({ summary, relations: [{ id: target.rel.id, codeRefs: [...target.rel.codeRefs, ref] }] });
    else
      void commit({
        summary,
        flows: [{ id: target.flow.id, steps: target.flow.steps.map((s, i) => (i === getState().stepIndex ? { ...s, codeRefs: [...s.codeRefs, ref] } : s)) }],
      });
    toast({ tone: 'info', text: `Linked lines ${lineRange(startLine, endLine)} to ${target.name}` });
    setRange(null);
  };

  function pickFromTextSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const lineOf = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.code-line');
    const a = lineOf(sel.anchorNode);
    const b = lineOf(sel.focusNode);
    if (a && b) setRange({ a: Number(a.dataset.line), b: Number(b.dataset.line) });
  }

  const editorUrl = hostPath ? `vscode://file/${hostPath.replace(/\/$/, '')}/${code.path}:${range ? Math.min(range.a, range.b) : (code.startLine ?? 1)}` : null;
  const marked = (n: number) => !!code.startLine && n >= code.startLine && n <= (code.endLine ?? code.startLine);
  const picked = (n: number) => !!range && n >= Math.min(range.a, range.b) && n <= Math.max(range.a, range.b);

  return (
    <section className="drawer" style={{ height }} aria-label={`Code: ${code.path}`}>
      <div
        className="drawer-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize code drawer"
        tabIndex={0}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragging.current = e.clientY + height;
        }}
        onPointerMove={(e) => {
          if (dragging.current === null) return;
          const h = Math.max(140, Math.min(window.innerHeight - 120, dragging.current - e.clientY));
          setHeight(h);
        }}
        onPointerUp={() => {
          dragging.current = null;
          try {
            localStorage.setItem(HEIGHT_KEY, String(height));
          } catch {
            /* ignore */
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') setHeight(Math.min(window.innerHeight - 120, height + 24));
          if (e.key === 'ArrowDown') setHeight(Math.max(140, height - 24));
        }}
      />
      <header className="drawer-head">
        <span className="drawer-path mono" title={code.path}>
          {code.path}
          {code.startLine ? <span className="drawer-lines">:{lineRange(code.startLine, code.endLine)}</span> : null}
        </span>
        <div className="drawer-chips">
          {linked.map((l) => (
            <button
              key={`${l.type}-${l.id}`}
              type="button"
              className={cx('chip', (selection.elementIds.includes(l.id) || selection.relationIds.includes(l.id)) && 'is-active')}
              onClick={() => (l.type === 'element' ? navigateToElement(l.id) : navigateToRelation(l.id))}
            >
              {l.kind && <KindIcon kind={l.kind as never} size={12} />}
              {l.name}
            </button>
          ))}
        </div>
        <div className="drawer-actions">
          {range && target && (
            <button type="button" className="btn btn-primary btn-small" onClick={linkSelection}>
              <Link2 size={13} strokeWidth={1.8} aria-hidden />
              Link lines {lineRange(Math.min(range.a, range.b), Math.max(range.a, range.b))} to {target.name}
            </button>
          )}
          {range && !target && <span className="muted small">Select an element to link these lines</span>}
          {editorUrl && (
            <Tip label="Open in editor">
              <a className="icon-btn" href={editorUrl} aria-label="Open in editor">
                <ExternalLink size={15} strokeWidth={1.7} />
              </a>
            </Tip>
          )}
          <IconButton icon={Copy} label="Copy path" size={15} onClick={() => void copyText(code.path).then(() => toast({ tone: 'info', text: 'Path copied' }))} />
          <IconButton icon={X} label="Close" keys="Esc" size={15} onClick={closeCode} />
        </div>
      </header>
      <div className="drawer-body" ref={scroller} onMouseUp={pickFromTextSelection}>
        {error && <p className="drawer-msg">{error}</p>}
        {file && !file.exists && <p className="drawer-msg is-warn">This file no longer exists in the repository.</p>}
        {!file && !error && <p className="drawer-msg muted">Loading…</p>}
        {file?.exists && file.content === undefined && <p className="drawer-msg muted">This file cannot be shown here.</p>}
        {lines.length > 0 && (
          <pre className="code-view">
            {lines.map((html, i) => {
              const n = i + 1;
              return (
                <div key={n} data-line={n} className={cx('code-line', marked(n) && 'is-ref', picked(n) && 'is-picked')}>
                  <span
                    className="code-no"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      if (e.shiftKey && range) setRange({ a: range.a, b: n });
                      else setRange(range && range.a === n && range.b === n ? null : { a: n, b: n });
                    }}
                    onPointerEnter={(e) => {
                      if (e.buttons === 1 && range) setRange({ a: range.a, b: n });
                    }}
                  >
                    {n}
                  </span>
                  <code dangerouslySetInnerHTML={{ __html: html || ' ' }} />
                </div>
              );
            })}
          </pre>
        )}
        {file?.truncated && <p className="drawer-msg muted">The file is truncated here.</p>}
      </div>
    </section>
  );
}
