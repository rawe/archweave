import { Maximize, Minus, Plus, Text, Undo2 } from 'lucide-react';
import { useViewport } from '@xyflow/react';
import { toggleNamesOnly, undo, useStore } from '../state/store.ts';
import { sendCanvasCommand } from '../lib/commands.ts';
import { MOD } from '../lib/format.ts';
import { IconButton, Tip } from './primitives.tsx';

export function CanvasControls({ zoomable, viewOptions }: { zoomable: boolean; viewOptions?: boolean }) {
  const humanChanged = useStore((s) => s.humanChanged);
  const namesOnly = useStore((s) => s.namesOnly);
  return (
    <div className="chrome chrome-bottom-left">
      {zoomable && <ZoomControls />}
      {viewOptions && (
        <div className="chrome-group">
          <IconButton
            icon={Text}
            label={namesOnly ? 'Show summaries' : 'Names only'}
            side="top"
            active={namesOnly}
            aria-pressed={namesOnly}
            onClick={toggleNamesOnly}
          />
        </div>
      )}
      {humanChanged && (
        <div className="chrome-group">
          <IconButton icon={Undo2} label="Undo" keys={`${MOD} Z`} side="top" onClick={() => void undo()} />
        </div>
      )}
    </div>
  );
}

function ZoomControls() {
  const { zoom } = useViewport();
  return (
    <div className="chrome-group zoom">
      <IconButton icon={Minus} label="Zoom out" keys="−" side="top" onClick={() => sendCanvasCommand('zoom-out')} />
      <Tip label="Zoom to 100%" keys="⇧ 0" side="top">
        <button type="button" className="zoom-level" onClick={() => sendCanvasCommand('zoom-reset')}>
          {Math.round(zoom * 100)}%
        </button>
      </Tip>
      <IconButton icon={Plus} label="Zoom in" keys="+" side="top" onClick={() => sendCanvasCommand('zoom-in')} />
      <IconButton icon={Maximize} label="Fit to screen" keys="⇧ 1" side="top" onClick={() => sendCanvasCommand('fit')} />
    </div>
  );
}
