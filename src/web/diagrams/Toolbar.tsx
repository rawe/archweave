import { useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import type { ShapeKind } from '../../shared/model.ts';
import { Picker } from '../chrome/Picker.tsx';
import { Tip } from '../chrome/primitives.tsx';
import { cx } from '../lib/dom.ts';
import { useStore } from '../state/store.ts';
import { addLinkedShape } from './actions.ts';
import { arm, useEditor } from './editor.ts';
import { ShapeGlyph, SHAPE_LABEL } from './glyphs.tsx';
import { linkItems, parseLinkItem } from './links.tsx';
import { KIND_KEYS } from './useDiagramKeys.ts';

const FIRST: ShapeKind[] = ['box', 'group', 'note', 'text'];
const MORE: ShapeKind[] = ['pill', 'cylinder', 'diamond', 'actor'];
const KEY_OF = Object.fromEntries(Object.entries(KIND_KEYS).map(([key, kind]) => [kind, key.toUpperCase()])) as Partial<Record<ShapeKind, string>>;

/** The floating shape toolbar: choosing a kind arms it for the next click on the canvas. */
export function Toolbar({ diagramId, centre }: { diagramId: string; centre: () => { x: number; y: number } }) {
  const armed = useEditor((s) => s.armed);
  const model = useStore((s) => s.model);
  const [picking, setPicking] = useState(false);
  const linkRef = useRef<HTMLButtonElement>(null);
  const button = (kind: ShapeKind) => (
    <Tip key={kind} label={armed === kind ? `${SHAPE_LABEL[kind]}: click the canvas to place it` : SHAPE_LABEL[kind]} keys={KEY_OF[kind]} side="top">
      <button type="button" className={cx('icon-btn', armed === kind && 'is-active')} aria-label={SHAPE_LABEL[kind]} aria-pressed={armed === kind} onClick={() => arm(armed === kind ? null : kind)}>
        <ShapeGlyph kind={kind} />
      </button>
    </Tip>
  );
  return (
    <div className="chrome dtoolbar" role="toolbar" aria-label="Shapes">
      <div className="chrome-group">
        {FIRST.map(button)}
        <span className="dtoolbar-sep" aria-hidden />
        {MORE.map(button)}
        <span className="dtoolbar-sep" aria-hidden />
        <Tip label="From the model: a shape that stands for an element, flow or diagram" side="top">
          <button ref={linkRef} type="button" className="icon-btn" aria-haspopup="dialog" aria-label="From the model" onClick={() => setPicking(true)}>
            <Link2 size={16} strokeWidth={1.7} aria-hidden />
          </button>
        </Tip>
      </div>
      {picking && (
        <Picker
          anchor={linkRef}
          placeholder="Element, flow or diagram"
          items={linkItems(model, diagramId)}
          onClose={() => setPicking(false)}
          onPick={(item) => addLinkedShape(parseLinkItem(item.id), centre())}
        />
      )}
    </div>
  );
}
