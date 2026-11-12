import { getState } from '../state/store.ts';
import { useEffect, useState, type RefObject } from 'react';
import { type FitViewOptions, useStoreApi, type ReactFlowInstance, type Node, type Edge } from '@xyflow/react';

export type ZoomClass = 'zoom-far' | 'zoom-mid' | 'zoom-near';

function bucket(zoom: number): ZoomClass {
  return zoom < 0.6 ? 'zoom-far' : zoom >= 1.1 ? 'zoom-near' : 'zoom-mid';
}

/** Publishes the zoom as a CSS variable on the wrapper and returns the semantic zoom level. */
export function useZoomClass(wrapper: RefObject<HTMLElement | null>): ZoomClass {
  const store = useStoreApi();
  const [cls, setCls] = useState<ZoomClass>(() => bucket(store.getState().transform[2]));
  useEffect(() => {
    const apply = (zoom: number) => {
      wrapper.current?.style.setProperty('--zoom', String(zoom));
      const next = bucket(zoom);
      setCls((c) => (c === next ? c : next));
    };
    apply(store.getState().transform[2]);
    let last = store.getState().transform[2];
    return store.subscribe((s) => {
      if (s.transform[2] !== last) {
        last = s.transform[2];
        apply(last);
      }
    });
  }, [store, wrapper]);
  return cls;
}

/** Everything on the canvas, framed for an image export. */
export async function captureFlow<N extends Node, E extends Edge>(rf: ReactFlowInstance<N, E>, wrapper: HTMLElement | null) {
  const viewportEl = wrapper?.querySelector<HTMLElement>('.react-flow__viewport');
  // Nodes still waiting for a position are invisible and must not stretch the frame.
  const nodes = rf.getNodes().filter((n) => !n.hidden && !String(n.className ?? '').includes('is-unplaced'));
  if (!viewportEl || !nodes.length) return null;
  const bounds = rf.getNodesBounds(nodes);
  const pad = 48;
  const width = Math.ceil(bounds.width + pad * 2);
  const height = Math.ceil(bounds.height + pad * 2);
  const vp = { x: pad - bounds.x, y: pad - bounds.y, zoom: 1 };
  return {
    node: viewportEl,
    width,
    height,
    style: { width: `${width}px`, height: `${height}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` },
  };
}

/** Fit options that keep content clear of the floating chrome, rail, inspector and code drawer. */
export function fitOptions(opts: { rail?: boolean; duration?: number } = {}): FitViewOptions {
  const s = getState();
  const wide = window.innerWidth >= 900;
  const inspector = wide && (s.selection.elementIds.length > 0 || s.selection.relationIds.length > 0);
  const app = document.querySelector<HTMLElement>('.app');
  const drawer = app ? parseFloat(getComputedStyle(app).getPropertyValue('--drawer-h')) || 0 : 0;
  return {
    padding: {
      top: '84px' as const,
      bottom: `${72 + drawer}px` as const,
      left: `${opts.rail && wide ? 276 : 56}px` as const,
      right: `${inspector ? 404 : 56}px` as const,
    },
    maxZoom: 1.2,
    duration: opts.duration ?? 0,
  };
}

/**
 * The part of a canvas wrapper not covered by floating chrome, in wrapper
 * coordinates: below the top bar, clear of the rail, the inspector (a side
 * panel on wide screens, a bottom sheet on narrow ones) and the code drawer.
 */
export function freeArea(wrapper: HTMLElement | null, withInspector: boolean, margin = 0, rail = false): { left: number; top: number; right: number; bottom: number } {
  const box = wrapper?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const wide = window.innerWidth >= 900;
  const app = document.querySelector<HTMLElement>('.app');
  const drawer = app ? parseFloat(getComputedStyle(app).getPropertyValue('--drawer-h')) || 0 : 0;
  let left = rail && wide ? 244 : 16;
  let right = box.width - 16;
  let bottom = box.height - 16 - drawer;
  const top = 72;
  if (withInspector) {
    const panel = document.querySelector<HTMLElement>('.inspector:not(.is-closing)');
    const r = panel?.getBoundingClientRect();
    if (wide) right = Math.min(right, r ? r.left - box.left - 16 : box.width - 404);
    else bottom = Math.min(bottom, r ? r.top - box.top - 12 : box.height * 0.42);
  }
  if (right - left < 160) left = Math.max(0, right - 160);
  return { left: left + margin, top: top + margin, right: right - margin, bottom: Math.max(top + 80, bottom - margin) };
}
