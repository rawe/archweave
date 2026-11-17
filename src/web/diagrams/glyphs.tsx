import type { ShapeKind } from '../../shared/model.ts';

export const SHAPE_LABEL: Record<ShapeKind, string> = {
  box: 'Box',
  group: 'Group',
  note: 'Note',
  text: 'Text',
  pill: 'Pill',
  cylinder: 'Cylinder',
  diamond: 'Diamond',
  actor: 'Actor',
};

const PATHS: Record<ShapeKind, React.ReactNode> = {
  box: <rect x="3.5" y="6.5" width="17" height="11" rx="2.5" />,
  group: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M6.5 8h5" />
    </>
  ),
  note: (
    <>
      <path d="M4 5.5h11.5l4.5 4.5v8.5H4z" />
      <path d="M15.5 5.5V10H20" />
    </>
  ),
  text: <path d="M6 6.5h12M12 6.5v12" />,
  pill: <rect x="3" y="7.5" width="18" height="9" rx="4.5" />,
  cylinder: (
    <>
      <ellipse cx="12" cy="6.5" rx="7.5" ry="2.5" />
      <path d="M4.5 6.5v11c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-11" />
    </>
  ),
  diamond: <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />,
  actor: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 20c0-3.9 2.9-6.5 6.5-6.5s6.5 2.6 6.5 6.5" />
    </>
  ),
};

/** A shape kind drawn as a small line icon in the style of the chrome's icons. */
export function ShapeGlyph({ kind, size = 16 }: { kind: ShapeKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round" aria-hidden>
      {PATHS[kind]}
    </svg>
  );
}
