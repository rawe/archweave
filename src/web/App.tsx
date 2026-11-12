import { ReactFlowProvider } from '@xyflow/react';
import { StructureCanvas } from './canvas/StructureCanvas.tsx';
import { DataView } from './data/DataView.tsx';
import { FlowsView } from './flows/FlowsView.tsx';
import { Inspector } from './inspector/Inspector.tsx';
import { CodeDrawer } from './code/CodeDrawer.tsx';
import { TopBar } from './chrome/TopBar.tsx';
import { CanvasControls } from './chrome/CanvasControls.tsx';
import { Toasts } from './chrome/Toasts.tsx';
import { EmptyState } from './chrome/EmptyState.tsx';
import { Palette } from './chrome/Palette.tsx';
import { ExportDialog } from './chrome/ExportDialog.tsx';
import { HelpSheet } from './chrome/HelpSheet.tsx';
import { ConfirmHost } from './chrome/Confirm.tsx';
import { useShortcuts } from './chrome/useShortcuts.ts';
import { dataFocusId, useStore } from './state/store.ts';
import { cx } from './lib/dom.ts';

export function App() {
  useShortcuts();
  const perspective = useStore((s) => s.perspective);
  const loaded = useStore((s) => s.loaded);
  const connection = useStore((s) => s.connection);
  const empty = useStore((s) => s.loaded && s.model.elements.length === 0 && s.model.flows.length === 0);
  const overlay = useStore((s) => s.overlay);
  const codeOpen = useStore((s) => !!s.code);
  const namesOnly = useStore((s) => s.namesOnly);
  const dataFocus = useStore((s) => (s.perspective === 'data' ? dataFocusId(s) : undefined));

  return (
    <ReactFlowProvider>
      <div className={cx('app', `perspective-${perspective}`, codeOpen && 'has-code', namesOnly && 'names-only')}>
        <main className="stage" aria-label={`${perspective} perspective`}>
          {loaded && perspective === 'structure' && <StructureCanvas key="structure" />}
          {loaded && perspective === 'data' && <DataView />}
          {loaded && perspective === 'flows' && <FlowsView />}
          {!loaded && <div className="loading">{connection === 'offline' ? 'Waiting for the ArchWeave server…' : ''}</div>}
          {empty && perspective === 'structure' && <EmptyState />}
        </main>
        <TopBar />
        <CanvasControls zoomable={perspective === 'structure' || (perspective === 'data' && !!dataFocus)} viewOptions={perspective === 'structure'} />
        <Inspector />
        <CodeDrawer />
        <Toasts />
        {connection === 'offline' && loaded && <div className="offline">Reconnecting to the server…</div>}
        {overlay === 'palette' && <Palette />}
        {overlay === 'export' && <ExportDialog />}
        {overlay === 'help' && <HelpSheet />}
        <ConfirmHost />
      </div>
    </ReactFlowProvider>
  );
}
