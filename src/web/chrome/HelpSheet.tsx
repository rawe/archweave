import { X } from 'lucide-react';
import { MOD } from '../lib/format.ts';
import { setOverlay } from '../state/store.ts';
import { FIRST_PROMPT } from './EmptyState.tsx';
import { IconButton, Keys } from './primitives.tsx';
import { useModalKeys } from './useModalKeys.ts';

const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Anywhere',
    items: [
      [`${MOD} K`, 'Search and commands'],
      ['1 2 3 4', 'Structure, Data, Flows, Diagrams'],
      [`${MOD} Z`, 'Undo'],
      [`${MOD} E`, 'Export'],
      ['⇧ T', 'Toggle theme'],
      ['Esc', 'Close, deselect, then go up a level'],
      ['?', 'This sheet'],
    ],
  },
  {
    group: 'Canvas',
    items: [
      ['N', 'New element, or double-click empty canvas'],
      ['↵', 'Open the selected element'],
      [`${MOD} ↑`, 'Go up a level'],
      ['⌫', 'Delete the selection'],
      ['⇧ click', 'Add to the selection, or ⇧ drag a box'],
      ['+ −', 'Zoom in and out'],
      ['⇧ 1', 'Fit to screen'],
      ['⇧ 0', 'Zoom to 100%'],
    ],
  },
  {
    group: 'Flows',
    items: [
      ['→ J', 'Next step'],
      ['← K', 'Previous step'],
    ],
  },
  {
    group: 'Diagrams',
    items: [
      ['B G S T', 'Box, group, note, text: click to place'],
      ['N', 'New box, or double-click empty canvas'],
      ['↵', 'Edit the text, ⇧ ↵ for a new line'],
      ['← → ↑ ↓', 'Nudge, with ⇧ by a single unit'],
      [`${MOD} D`, 'Duplicate'],
      [`${MOD} C ${MOD} V`, 'Copy and paste, also into another diagram'],
      [`${MOD} A`, 'Select everything'],
      ['] [', 'Bring to front, send to back'],
    ],
  },
];

export function HelpSheet() {
  const close = () => setOverlay(null);
  useModalKeys(close);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog help" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div className="help-head">
          <h2 id="help-title" className="dialog-title">
            Working in ArchWeave
          </h2>
          <IconButton icon={X} label="Close" keys="Esc" onClick={close} />
        </div>
        <div className="help-cols">
          <div className="help-prose">
            <p>
              Your coding agent sees the same model you do. Connect it over MCP from the activity button, then ask in plain words. A good
              start is “{FIRST_PROMPT}” The agent reads the code, draws the parts and links each one to the files behind it.
            </p>
            <p>
              Select something before you ask about it. The agent can read your current selection and scope, so “why does this call that”
              or “split this in two” needs no further explanation. Copy prompt in the inspector gives you a ready sentence.
            </p>
            <p>
              Planned elements and notes are how you hand over work. Draw what should exist, leave a note for the agent, and it will build
              toward it and mark things built as the code catches up. Changes by the agent glow in saffron until you have looked at them.
            </p>
            <p>
              Diagrams are drawings beside the model, made to explain one idea to people. A shape can stand for an element, flow or diagram
              and then shows its live name. Make this an element turns a drawn box into a planned element; Add from model starts a drawing
              from what is modeled. The agent draws and reads diagrams too: “Draw the checkout path as a diagram.”
            </p>
          </div>
          <div className="help-keys">
            {SHORTCUTS.map((g) => (
              <section key={g.group}>
                <h3 className="section-label">{g.group}</h3>
                <dl>
                  {g.items.map(([keys, what]) => (
                    <div key={keys} className="help-row">
                      <dt>
                        <Keys keys={keys} />
                      </dt>
                      <dd>{what}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
