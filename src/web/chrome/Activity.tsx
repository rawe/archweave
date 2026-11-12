import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy } from 'lucide-react';
import type { JournalEntry } from '../../shared/model.ts';
import { navigateToEntry, setOverlay, useStore } from '../state/store.ts';
import { copyText, cx } from '../lib/dom.ts';
import { relativeTime } from '../lib/format.ts';
import { Tip, useDismiss } from './primitives.tsx';

export function mcpUrl(): string {
  return `${location.origin}/mcp`;
}

export function mcpConfig(): string {
  return JSON.stringify({ mcpServers: { archweave: { type: 'http', url: mcpUrl() } } }, null, 2);
}

export function PresenceButton({ buttonRef }: { buttonRef: RefObject<HTMLButtonElement | null> }) {
  const agent = useStore((s) => s.agent);
  const ever = useStore((s) => s.agentEverSeen);
  const overlay = useStore((s) => s.overlay);
  const label = agent.connected
    ? `Agent connected${agent.clientName ? ` · ${agent.clientName}` : ''}`
    : ever
      ? `Agent away${agent.lastSeenAt ? ` · seen ${relativeTime(agent.lastSeenAt)}` : ''}`
      : 'No agent connected yet';
  return (
    <Tip label={`${label}. Activity`}>
      <button
        ref={buttonRef}
        type="button"
        className={cx('icon-btn', 'presence', overlay === 'activity' && 'is-active')}
        aria-label={`${label}. Show activity`}
        aria-expanded={overlay === 'activity'}
        onClick={() => setOverlay(overlay === 'activity' ? null : 'activity')}
      >
        <span className={cx('presence-dot', agent.connected ? 'is-on' : ever ? 'is-away' : 'is-never')} aria-hidden />
      </button>
    </Tip>
  );
}

export function ConnectSnippet({ compact }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = mcpConfig();
  return (
    <div className={cx('snippet', compact && 'is-compact')}>
      <code>{text}</code>
      <Tip label={copied ? 'Copied' : 'Copy config'} side="top">
        <button
          type="button"
          className="icon-btn snippet-copy"
          aria-label="Copy MCP config"
          onClick={() =>
            void copyText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            })
          }
        >
          {copied ? <Check size={14} strokeWidth={1.8} /> : <Copy size={14} strokeWidth={1.7} />}
        </button>
      </Tip>
    </div>
  );
}

export function ActivityPopover({ anchor }: { anchor: RefObject<HTMLElement | null> }) {
  const journal = useStore((s) => s.journal);
  const ever = useStore((s) => s.agentEverSeen);
  const agent = useStore((s) => s.agent);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [, tick] = useState(0);
  useDismiss(ref, true, () => setOverlay(null), anchor);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 8, right: Math.max(12, window.innerWidth - r.right - 8) });
  }, [anchor]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const entries = [...journal].reverse().slice(0, 80);

  return createPortal(
    <div ref={ref} className="popover activity" role="dialog" aria-label="Activity" style={pos ?? { top: -9999, right: 0 }}>
      {!ever ? (
        <div className="activity-connect">
          <p className="activity-lead">No agent has connected yet.</p>
          <p className="muted">Add ArchWeave to your coding agent as an MCP server:</p>
          <ConnectSnippet />
          <p className="muted small">
            Server URL <code className="mono">{mcpUrl()}</code>
          </p>
        </div>
      ) : (
        <div className="activity-status">
          <span className={cx('presence-dot', agent.connected ? 'is-on' : 'is-away')} aria-hidden />
          {agent.connected ? (agent.clientName ? `${agent.clientName} is connected` : 'An agent is connected') : `Agent last seen ${relativeTime(agent.lastSeenAt) || 'a while ago'}`}
        </div>
      )}
      {entries.length > 0 ? (
        <ol className="activity-list">
          {entries.map((e) => (
            <ActivityRow key={`${e.revision}-${e.at}`} entry={e} />
          ))}
        </ol>
      ) : (
        ever && <p className="activity-empty muted">Nothing has changed yet.</p>
      )}
    </div>,
    document.body,
  );
}

function ActivityRow({ entry }: { entry: JournalEntry }) {
  return (
    <li>
      <button
        type="button"
        className={cx('activity-row', `by-${entry.actor}`)}
        onClick={() => {
          setOverlay(null);
          navigateToEntry(entry);
        }}
      >
        <span className="activity-author" aria-label={entry.actor === 'agent' ? 'Agent' : 'You'} />
        <span className="activity-summary">{entry.summary}</span>
        <time className="activity-time" dateTime={entry.at}>
          {relativeTime(entry.at)}
        </time>
      </button>
    </li>
  );
}
