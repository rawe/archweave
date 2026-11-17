import { Shapes, Workflow } from 'lucide-react';
import type { Model, ModelLink } from '../../shared/model.ts';
import type { PickItem } from '../chrome/Picker.tsx';
import { KindIcon } from '../lib/kinds.tsx';
import { buildIndex, scopePath } from '../state/selectors.ts';

/** Everything a shape can stand for, as picker entries: elements, flows, and the other diagrams. */
export function linkItems(model: Model, exceptDiagram?: string): PickItem[] {
  const index = buildIndex(model);
  return [
    ...model.elements.map((e) => ({ id: `element:${e.id}`, label: e.name, detail: scopePath(e, index) || undefined, icon: <KindIcon kind={e.kind} size={13} /> })),
    ...model.flows.map((f) => ({ id: `flow:${f.id}`, label: f.name, detail: 'flow', icon: <LinkIcon type="flow" /> })),
    ...model.diagrams.filter((d) => d.id !== exceptDiagram).map((d) => ({ id: `diagram:${d.id}`, label: d.name, detail: 'diagram', icon: <LinkIcon type="diagram" /> })),
  ];
}

export function parseLinkItem(id: string): ModelLink {
  const at = id.indexOf(':');
  return { type: id.slice(0, at) as ModelLink['type'], id: id.slice(at + 1) };
}

export function LinkIcon({ type, size = 13 }: { type: 'flow' | 'diagram'; size?: number }) {
  const Icon = type === 'flow' ? Workflow : Shapes;
  return <Icon size={size} strokeWidth={1.6} aria-hidden />;
}
