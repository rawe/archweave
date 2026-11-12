import { useRef, useState } from 'react';
import { ChevronRight, CircleQuestionMark, Download, Moon, Search, Sun } from 'lucide-react';
import type { Perspective } from '../../shared/model.ts';
import { ancestorsOf, indexById } from '../../shared/projection.ts';
import { renameModel } from '../state/actions.ts';
import { enterScope, openFlow, setOverlay, setPerspective, useStore } from '../state/store.ts';
import { cx } from '../lib/dom.ts';
import { MOD } from '../lib/format.ts';
import { toggleTheme, useTheme } from '../lib/theme.ts';
import { IconButton, Tip } from './primitives.tsx';
import { ActivityPopover, PresenceButton } from './Activity.tsx';

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" width="22" height="22" aria-hidden>
      <path d="M6 11.5C11.5 11.5 12.5 20.5 18 20.5S24.5 11.5 26 11.5" fill="none" stroke="var(--human)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M6 20.5C11.5 20.5 12.5 11.5 18 11.5S24.5 20.5 26 20.5" fill="none" stroke="var(--agent)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  );
}

const PERSPECTIVES: { id: Perspective; label: string; key: string }[] = [
  { id: 'structure', label: 'Structure', key: '1' },
  { id: 'data', label: 'Data', key: '2' },
  { id: 'flows', label: 'Flows', key: '3' },
];

export function TopBar() {
  const theme = useTheme();
  const overlay = useStore((s) => s.overlay);
  const presenceRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <div className="chrome chrome-left">
        <Breadcrumb />
      </div>
      <div className="chrome chrome-center">
        <PerspectiveSwitch />
      </div>
      <div className="chrome chrome-right">
        <IconButton icon={Search} label="Search and commands" keys={`${MOD} K`} onClick={() => setOverlay('palette')} />
        <PresenceButton buttonRef={presenceRef} />
        <IconButton icon={Download} label="Export" keys={`${MOD} E`} onClick={() => setOverlay('export')} />
        <IconButton
          icon={theme === 'dark' ? Sun : Moon}
          label={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          keys="⇧ T"
          onClick={toggleTheme}
        />
        <IconButton icon={CircleQuestionMark} label="Shortcuts and help" keys="?" onClick={() => setOverlay('help')} />
      </div>
      {overlay === 'activity' && <ActivityPopover anchor={presenceRef} />}
    </>
  );
}

function PerspectiveSwitch() {
  const perspective = useStore((s) => s.perspective);
  return (
    <div className="segmented" role="tablist" aria-label="Perspective">
      {PERSPECTIVES.map((p) => (
        <Tip key={p.id} label={`${p.label} perspective`} keys={p.key}>
          <button
            type="button"
            role="tab"
            aria-selected={perspective === p.id}
            className={cx('segment', perspective === p.id && 'is-active')}
            onClick={() => setPerspective(p.id)}
          >
            {p.label}
          </button>
        </Tip>
      ))}
    </div>
  );
}

function Breadcrumb() {
  const model = useStore((s) => s.model);
  const perspective = useStore((s) => s.perspective);
  const scopeId = useStore((s) => s.scopeId);
  const flowId = useStore((s) => s.flowId);
  const repo = useStore((s) => s.repo);
  const [editing, setEditing] = useState(false);
  const byId = indexById(model.elements);
  const scope = scopeId ? byId.get(scopeId) : undefined;
  const crumbs = perspective === 'structure' && scope ? [...ancestorsOf(scope.id, byId), scope] : [];
  const flow = perspective === 'flows' ? model.flows.find((f) => f.id === flowId) : undefined;
  const rootName = model.name && model.name !== 'Architecture' ? model.name : repo.name || model.name;
  const atRoot = perspective === 'structure' ? !scopeId : perspective === 'flows' ? !flow : true;

  return (
    <nav className="breadcrumb" aria-label="Scope">
      <Mark />
      {editing ? (
        <input
          className="crumb-input"
          autoFocus
          defaultValue={rootName}
          aria-label="Model name"
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value.trim() && e.target.value.trim() !== rootName) renameModel(e.target.value);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <button
          type="button"
          className={cx('crumb', 'crumb-root', atRoot && 'is-current')}
          onClick={() => (perspective === 'flows' ? openFlow(undefined) : enterScope(undefined))}
          onDoubleClick={() => setEditing(true)}
          title={atRoot ? 'Double-click to rename' : undefined}
        >
          {rootName}
        </button>
      )}
      {crumbs.map((el, i) => (
        <span key={el.id} className="crumb-step">
          <ChevronRight size={13} strokeWidth={1.6} className="crumb-sep" aria-hidden />
          <button
            type="button"
            className={cx('crumb', i === crumbs.length - 1 && 'is-current')}
            onClick={() => enterScope(el.id)}
            aria-current={i === crumbs.length - 1 ? 'location' : undefined}
          >
            {el.name}
          </button>
        </span>
      ))}
      {flow && (
        <span className="crumb-step">
          <ChevronRight size={13} strokeWidth={1.6} className="crumb-sep" aria-hidden />
          <span className="crumb is-current">{flow.name}</span>
        </span>
      )}
    </nav>
  );
}
