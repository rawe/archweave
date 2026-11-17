import { api } from '../api.ts';
import { cx } from '../lib/dom.ts';
import { toast } from '../state/store.ts';

export interface ImageOptions {
  theme: 'light' | 'dark';
  background: 'canvas' | 'white' | 'transparent';
  scale: number;
}

const THEMES: ImageOptions['theme'][] = ['light', 'dark'];
const BACKGROUNDS: ImageOptions['background'][] = ['canvas', 'white', 'transparent'];
const SCALES = [1, 2, 3, 4];

function Choice<T extends string | number>({ legend, values, value, label, onChange }: { legend: string; values: T[]; value: T; label: (v: T) => string; onChange: (v: T) => void }) {
  return (
    <fieldset className="field-group">
      <legend>{legend}</legend>
      <div className="radio-row">
        {values.map((v) => (
          <label key={v} className={cx('pill', value === v && 'is-active')}>
            <input type="radio" name={legend} checked={value === v} onChange={() => onChange(v)} />
            {label(v)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Theme, background and scale of a diagram picture, with a preview drawn by the same route that exports it. */
export function DiagramImageOptions({ diagramId, format, value, onChange, version }: { diagramId: string; format: 'png' | 'svg'; value: ImageOptions; onChange: (v: ImageOptions) => void; version: number }) {
  const preview = api.diagramImageUrl(diagramId, { format: 'svg', theme: value.theme, background: value.background, version });
  return (
    <>
      <div className={cx('export-preview', `bg-${value.background}`)}>
        <img src={preview} alt="Preview of the exported diagram" />
      </div>
      <Choice legend="Theme" values={THEMES} value={value.theme} label={(t) => (t === 'light' ? 'Light' : 'Dark')} onChange={(theme) => onChange({ ...value, theme })} />
      <Choice legend="Background" values={BACKGROUNDS} value={value.background} label={(b) => b[0]!.toUpperCase() + b.slice(1)} onChange={(background) => onChange({ ...value, background })} />
      {format === 'png' && <Choice legend="Scale" values={SCALES} value={value.scale} label={(s) => `${s}×`} onChange={(scale) => onChange({ ...value, scale })} />}
    </>
  );
}

export const canCopyImage = typeof ClipboardItem !== 'undefined' && typeof navigator !== 'undefined' && !!navigator.clipboard?.write;

/** Puts the PNG on the clipboard. The fetch is handed over as a promise so the browser keeps the click's permission. */
export async function copyDiagramImage(diagramId: string, options: ImageOptions): Promise<boolean> {
  const url = api.diagramImageUrl(diagramId, { format: 'png', ...options });
  try {
    const blob = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`The server answered ${r.status}`);
      return r.blob();
    });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast({ tone: 'info', text: 'Image copied' });
    return true;
  } catch {
    toast({ tone: 'error', text: 'The browser did not let the image onto the clipboard. Export it instead.' });
    return false;
  }
}
