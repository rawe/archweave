import { createContext, type PointerEvent } from 'react';
import type { ConnectorGeometry } from '../../shared/diagram/route.ts';
import type { DiagramTheme } from '../../shared/diagram/theme.ts';
import type { ModelLink } from '../../shared/model.ts';
import type { ResizeHandle } from './geometry.ts';

/** What shape nodes need from the canvas; stable while the theme stays. */
export interface ShapeTools {
  theme: DiagramTheme;
  startResize: (id: string, handle: ResizeHandle, event: PointerEvent) => void;
  openLink: (link: ModelLink) => void;
}

/** The routes of every connector, from one routing pass over the live shape rectangles. */
export interface Routes {
  theme: DiagramTheme;
  routes: Map<string, ConnectorGeometry>;
  startReconnect: (id: string, end: 'from' | 'to', event: PointerEvent) => void;
}

export const ShapeToolsContext = createContext<ShapeTools | null>(null);
export const RoutesContext = createContext<Routes | null>(null);
