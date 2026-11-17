import { useState } from 'react';
import { toPng, toSvg } from 'html-to-image';
import { inlineSvgPaint } from '../lib/exportPaint.ts';
import { slugify, type Perspective } from '../../shared/model.ts';
import { api } from '../api.ts';
import { getCanvasTarget } from '../lib/canvasTarget.ts';
import { cx } from '../lib/dom.ts';
import { getState, setOverlay, toast, useStore } from '../state/store.ts';
import { useModalKeys } from './useModalKeys.ts';
import { canCopyImage, copyDiagramImage, DiagramImageOptions, type ImageOptions } from '../diagrams/DiagramExport.tsx';

type Format = 'markdown' | 'mermaid' | 'json' | 'png' | 'svg';

const FORMATS: { id: Format; label: string; detail: string }[] = [
  { id: 'markdown', label: 'Markdown document', detail: 'Diagrams, text, fields, flows' },
  { id: 'mermaid', label: 'Mermaid', detail: 'Just the diagrams' },
  { id: 'json', label: 'JSON', detail: 'Model and layout as stored' },
  { id: 'png', label: 'PNG', detail: 'Image of the canvas' },
  { id: 'svg', label: 'SVG', detail: 'Vector image of the canvas' },
];

const PERSPECTIVE_LABEL: Record<Perspective, string> = { structure: 'Structure', data: 'Data', flows: 'Flows', diagrams: 'Diagrams' };

export function ExportDialog() {
  const scopeId = useStore((s) => s.scopeId);
  const perspective = useStore((s) => s.perspective);
  const scope = useStore((s) => s.model.elements.find((e) => e.id === s.scopeId));
  const diagram = useStore((s) => (s.perspective === 'diagrams' ? s.model.diagrams.find((d) => d.id === s.diagramId) : undefined));
  const revision = useStore((s) => s.revision);
  const [format, setFormat] = useState<Format>(diagram ? 'png' : 'markdown');
  // Exports mostly go into documents, so a diagram picture is light unless asked otherwise.
  const [picture, setPicture] = useState<ImageOptions>({ theme: 'light', background: 'canvas', scale: 2 });
  const [what, setWhat] = useState<'scope' | 'all'>(scopeId ? 'scope' : 'all');
  const [perspectives, setPerspectives] = useState<Perspective[]>(['structure', 'data', 'flows']);
  const [code, setCode] = useState(true);
  const [busy, setBusy] = useState(false);
  const close = () => setOverlay(null);
  useModalKeys(close);
  const image = format === 'png' || format === 'svg';

  const run = async () => {
    if (image && diagram) {
      download(api.diagramImageUrl(diagram.id, { format: format as 'png' | 'svg', ...picture, download: true }), '');
      close();
      return;
    }
    if (image) {
      setBusy(true);
      let restorePaint: (() => void) | undefined;
      try {
        const captured = await getCanvasTarget()?.capture();
        if (!captured) {
          toast({ tone: 'info', text: 'There is nothing on the canvas to export.' });
          return;
        }
        const background = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim();
        document.documentElement.classList.add('is-exporting');
        restorePaint = inlineSvgPaint(captured.node);
        const options = {
          width: captured.width,
          height: captured.height,
          backgroundColor: background,
          pixelRatio: 2,
          style: captured.style as Record<string, string>,
          filter: (node: HTMLElement) => !node.classList?.contains('react-flow__handle'),
        };
        const url = format === 'png' ? await toPng(captured.node, options) : await toSvg(captured.node, options);
        download(url, `${baseName()}-${perspective}.${format}`);
        close();
      } catch (e) {
        toast({ tone: 'error', text: `Image export failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        restorePaint?.();
        document.documentElement.classList.remove('is-exporting');
        setBusy(false);
      }
      return;
    }
    const url = api.exportUrl({ format, scope: what === 'scope' ? scopeId : undefined, perspectives, code });
    download(url, '');
    close();
  };

  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog export" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <h2 id="export-title" className="dialog-title">
          Export
        </h2>
        <fieldset className="field-group">
          <legend>Format</legend>
          <div className="format-grid">
            {FORMATS.map((f) => (
              <label key={f.id} className={cx('format', format === f.id && 'is-active')}>
                <input type="radio" name="format" value={f.id} checked={format === f.id} onChange={() => setFormat(f.id)} />
                <span className="format-label">{f.label}</span>
                <span className="format-detail">{diagram && (f.id === 'png' || f.id === 'svg') ? `${diagram.name} as ${f.id === 'png' ? 'a picture' : 'a vector image'}` : f.detail}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {!image && (
          <>
            <fieldset className="field-group">
              <legend>What</legend>
              <div className="radio-row">
                <label className={cx('pill', what === 'scope' && 'is-active', !scopeId && 'is-disabled')}>
                  <input type="radio" name="what" disabled={!scopeId} checked={what === 'scope'} onChange={() => setWhat('scope')} />
                  {scope ? `Inside ${scope.name}` : 'Current scope'}
                </label>
                <label className={cx('pill', what === 'all' && 'is-active')}>
                  <input type="radio" name="what" checked={what === 'all'} onChange={() => setWhat('all')} />
                  Everything
                </label>
              </div>
            </fieldset>
            <fieldset className="field-group">
              <legend>Perspectives</legend>
              <div className="radio-row">
                {(['structure', 'data', 'flows'] as Perspective[]).map((p) => (
                  <label key={p} className={cx('pill', perspectives.includes(p) && 'is-active')}>
                    <input
                      type="checkbox"
                      checked={perspectives.includes(p)}
                      onChange={(e) => setPerspectives((list) => (e.target.checked ? [...list, p] : list.filter((x) => x !== p)))}
                    />
                    {PERSPECTIVE_LABEL[p]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="check">
              <input type="checkbox" checked={code} onChange={(e) => setCode(e.target.checked)} />
              Include code links
            </label>
          </>
        )}
        {image && diagram && <DiagramImageOptions diagramId={diagram.id} format={format as 'png' | 'svg'} value={picture} onChange={setPicture} version={revision} />}
        {image && !diagram && <p className="dialog-body muted">The {PERSPECTIVE_LABEL[perspective]} canvas as you see it now, framed to fit everything on it.</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          {image && diagram && canCopyImage && (
            <button type="button" className="btn" onClick={() => void copyDiagramImage(diagram.id, picture).then((ok) => ok && close())}>
              Copy image
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={busy || (!image && !perspectives.length)} onClick={() => void run()}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}

function baseName(): string {
  const { model, repo } = getState();
  return slugify(model.name !== 'Architecture' ? model.name : repo.name || 'architecture');
}

function download(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
