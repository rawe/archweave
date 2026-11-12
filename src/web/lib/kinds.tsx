import {
  AppWindow,
  Bot,
  Boxes,
  Braces,
  Component,
  Database,
  Globe,
  Inbox,
  Package,
  Server,
  User,
  type LucideIcon,
} from 'lucide-react';
import type { ElementKind, RelationKind } from '../../shared/model.ts';

export const KIND_ICON: Record<ElementKind, LucideIcon> = {
  system: Boxes,
  actor: User,
  external: Globe,
  app: AppWindow,
  service: Server,
  component: Component,
  module: Package,
  store: Database,
  queue: Inbox,
  agent: Bot,
  data: Braces,
};

export const KIND_LABEL: Record<ElementKind, string> = {
  system: 'System',
  actor: 'Actor',
  external: 'External system',
  app: 'App',
  service: 'Service',
  component: 'Component',
  module: 'Module',
  store: 'Store',
  queue: 'Queue',
  agent: 'Agent',
  data: 'Data structure',
};

/** Kinds offered when creating on the structure canvas, in Tab order. */
export const STRUCTURE_KINDS: ElementKind[] = ['service', 'app', 'component', 'module', 'store', 'queue', 'external', 'actor', 'agent', 'system'];

export function KindIcon({ kind, size = 14, className }: { kind: ElementKind; size?: number; className?: string }) {
  const Icon = KIND_ICON[kind];
  return <Icon size={size} strokeWidth={1.6} className={className} aria-hidden />;
}

export const RELATION_VERB: Record<RelationKind, string> = {
  uses: 'uses',
  calls: 'calls',
  reads: 'reads',
  writes: 'writes',
  publishes: 'publishes to',
  subscribes: 'subscribes to',
  produces: 'produces',
  consumes: 'consumes',
  references: 'references',
};

export const DATA_VERBS: RelationKind[] = ['produces', 'consumes', 'reads', 'writes'];
