import { useEffect, useRef, useState } from 'react';
import { Composer } from '../canvas/Composer.tsx';
import { createElement } from '../state/actions.ts';
import { dataFocusId, select, useStore } from '../state/store.ts';
import { onCanvasCommand } from '../lib/commands.ts';
import { cx } from '../lib/dom.ts';
import { DataRail } from './DataRail.tsx';
import { DataCatalog } from './DataCatalog.tsx';
import { DataFocus } from './DataFocus.tsx';

/**
 * The data perspective: a catalog of every structure when nothing is selected,
 * a focus view around one structure when one is. The rail lists them all.
 */
export function DataView() {
  const railOpen = useStore((s) => s.dataRailOpen);
  const focus = useStore(dataFocusId);
  const [composing, setComposing] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => onCanvasCommand((cmd) => cmd === 'compose' && setComposing(true)), []);

  return (
    <div ref={wrapper} className={cx('data-view', railOpen && 'has-rail', focus ? 'is-focus' : 'is-catalog')}>
      {focus ? <DataFocus focusId={focus} /> : <DataCatalog />}
      <DataRail />
      {composing && (
        <div className="data-composer">
          <Composer
            at={{ x: 0, y: 0 }}
            defaultKind="data"
            kinds={['data']}
            placeholder="Structure name"
            onCancel={() => setComposing(false)}
            onCreate={(name) => {
              setComposing(false);
              void createElement({ name, kind: 'data' }).then((id) => select({ elementIds: [id] }));
            }}
          />
        </div>
      )}
    </div>
  );
}
