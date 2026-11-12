import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { sendCanvasCommand } from '../lib/commands.ts';
import { copyText } from '../lib/dom.ts';
import { ConnectSnippet } from './Activity.tsx';
import { Keys, Tip } from './primitives.tsx';

export const FIRST_PROMPT = 'Analyze this repository and model its architecture in ArchWeave.';

export function EmptyState() {
  const [copied, setCopied] = useState(false);
  return (
    <div className="empty">
      <div className="empty-card">
        <h1 className="empty-title">Nothing drawn yet</h1>
        <p className="empty-lead">
          Sketch the architecture here, or let your coding agent read the repository and build it for you.
        </p>
        <div className="empty-step">
          <span className="empty-label">Connect the agent over MCP</span>
          <ConnectSnippet />
        </div>
        <div className="empty-step">
          <span className="empty-label">Then ask it</span>
          <div className="prompt-line">
            <span>{FIRST_PROMPT}</span>
            <Tip label={copied ? 'Copied' : 'Copy prompt'} side="top">
              <button
                type="button"
                className="icon-btn"
                aria-label="Copy prompt"
                onClick={() =>
                  void copyText(FIRST_PROMPT).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  })
                }
              >
                {copied ? <Check size={14} strokeWidth={1.8} /> : <Copy size={14} strokeWidth={1.7} />}
              </button>
            </Tip>
          </div>
        </div>
        <div className="empty-or">
          <button type="button" className="btn" onClick={() => sendCanvasCommand('compose')}>
            Draw the first element
          </button>
          <span className="muted">
            or double-click anywhere, or press <Keys keys="N" />
          </span>
        </div>
      </div>
    </div>
  );
}
