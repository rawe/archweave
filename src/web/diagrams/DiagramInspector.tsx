import { useRef, useState } from 'react';
import { ArrowLeftRight, ArrowRight, ArrowUpRight, Link2, Sparkles, Trash, Unlink } from 'lucide-react';
import {
  CONNECTOR_ENDS,
  CONNECTOR_ROUTES,
  type Diagram,
  type DiagramConnector,
  type DiagramShape,
  type ElementKind,
  FILLS,
  LINE_STYLES,
  OUTLINES,
  SHAPE_KINDS,
  type ShapeKind,
  type ShapePatch,
  TEXT_SIZES,
  type Tone,
  TONES,
} from '../../shared/model.ts';
import { linkName, shapeLabel } from '../../shared/diagram/links.ts';
import { unlinkShape } from '../../shared/diagram/patch.ts';
import { connectorEnds, promotedKind } from '../../shared/diagram/promote.ts';
import { KIND_DEFAULTS } from '../../shared/diagram/style.ts';
import { type DiagramTheme, THEMES } from '../../shared/diagram/theme.ts';
import { Picker } from '../chrome/Picker.tsx';
import { Menu, Tip } from '../chrome/primitives.tsx';
import { InlineText, Section, Segmented } from '../inspector/fields.tsx';
import { cx } from '../lib/dom.ts';
import { plural } from '../lib/format.ts';
import { KIND_LABEL, KindIcon, STRUCTURE_KINDS } from '../lib/kinds.tsx';
import { useTheme } from '../lib/theme.ts';
import { useStore } from '../state/store.ts';
import { makeElement, makeRelation, openLink, removeShapes, reverseConnector, setConnectors, setShapes } from './actions.ts';
import { ShapeGlyph, SHAPE_LABEL } from './glyphs.tsx';
import { LinkIcon, linkItems, parseLinkItem } from './links.tsx';

const TONE_LABEL: Record<Tone, string> = { neutral: 'Neutral', blue: 'Blue', teal: 'Teal', green: 'Green', amber: 'Amber', red: 'Red', violet: 'Violet' };
const options = <T extends string>(values: readonly T[], labels: Partial<Record<T, string>> = {}) =>
  values.map((value) => ({ value, label: labels[value] ?? value[0]!.toUpperCase() + value.slice(1) }));

/** The one value all of them share, or undefined when they differ. */
function common<T>(values: T[]): T | undefined {
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

/** The inspector of the selected shapes, or of the selected lines when no shape is selected. */
export function DiagramInspector({ diagram, ids }: { diagram: Diagram; ids: string[] }) {
  const theme = THEMES[useTheme()];
  const shapes = diagram.shapes.filter((s) => ids.includes(s.id));
  const connectors = diagram.connectors.filter((c) => ids.includes(c.id));
  if (shapes.length) return <ShapeInspector diagram={diagram} shapes={shapes} theme={theme} />;
  if (connectors.length) return <ConnectorInspector diagram={diagram} connectors={connectors} theme={theme} />;
  return null;
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dprop">
      <span className="dprop-label">{label}</span>
      {children}
    </div>
  );
}

function Swatches({ value, onChange, theme }: { value?: Tone; onChange: (tone: Tone) => void; theme: DiagramTheme }) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Tone">
      {TONES.map((tone) => (
        <Tip key={tone} label={TONE_LABEL[tone]} side="top">
          <button
            type="button"
            role="radio"
            aria-checked={value === tone}
            aria-label={TONE_LABEL[tone]}
            className={cx('swatch', value === tone && 'is-active')}
            style={{ '--swatch-line': theme.tones[tone].stroke, '--swatch-fill': theme.tones[tone].tint } as React.CSSProperties}
            onClick={() => onChange(tone)}
          />
        </Tip>
      ))}
    </div>
  );
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

type StyleKey = 'outline' | 'tone' | 'fill' | 'size';

function ShapeInspector({ diagram, shapes, theme }: { diagram: Diagram; shapes: DiagramShape[]; theme: DiagramTheme }) {
  const model = useStore((s) => s.model);
  const one = shapes.length === 1 ? shapes[0]! : undefined;
  const effective = (key: StyleKey) => common(shapes.map((s) => s[key] ?? KIND_DEFAULTS[s.kind][key]));
  // The kind's default is written as null, so a diagram file records only what its author chose.
  const choose = <K extends StyleKey>(key: K, value: NonNullable<DiagramShape[K]>) =>
    setShapes(
      diagram,
      shapes.flatMap((s): ShapePatch[] => {
        const next = value === KIND_DEFAULTS[s.kind][key] ? undefined : value;
        return next === s[key] ? [] : [{ id: s.id, [key]: next ?? null }];
      }),
    );
  const setKind = (kind: ShapeKind) => {
    const entries: ShapePatch[] = shapes.filter((s) => s.kind !== kind).map((s) => ({ id: s.id, kind }));
    if (kind !== 'group') {
      const ungrouped = new Set(entries.map((e) => e.id));
      for (const s of diagram.shapes) if (s.parent && ungrouped.has(s.parent) && !ungrouped.has(s.id)) entries.push({ id: s.id, parent: null });
    }
    setShapes(diagram, entries);
  };
  const kind = common(shapes.map((s) => s.kind));

  return (
    <div className="inspector-body">
      <header className="insp-head">
        {one ? <ShapeText diagram={diagram} shape={one} /> : <h2 className="insp-multi">{plural(shapes.length, 'shape')} selected</h2>}
      </header>
      <Prop label="Shape">
        <div className="kind-row" role="radiogroup" aria-label="Shape">
          {SHAPE_KINDS.map((k) => (
            <Tip key={k} label={SHAPE_LABEL[k]} side="top">
              <button type="button" role="radio" aria-checked={kind === k} aria-label={SHAPE_LABEL[k]} className={cx('kind-btn', kind === k && 'is-active')} onClick={() => setKind(k)}>
                <ShapeGlyph kind={k} size={15} />
              </button>
            </Tip>
          ))}
        </div>
      </Prop>
      <Prop label="Tone">
        <Swatches value={effective('tone') as Tone | undefined} onChange={(tone) => choose('tone', tone)} theme={theme} />
      </Prop>
      <Prop label="Fill">
        <Segmented label="Fill" value={(effective('fill') ?? '') as (typeof FILLS)[number]} options={options(FILLS)} onChange={(fill) => choose('fill', fill)} />
      </Prop>
      <Prop label="Outline">
        <Segmented label="Outline" value={(effective('outline') ?? '') as (typeof OUTLINES)[number]} options={options(OUTLINES)} onChange={(outline) => choose('outline', outline)} />
      </Prop>
      <Prop label="Text">
        <Segmented label="Text size" value={(effective('size') ?? '') as (typeof TEXT_SIZES)[number]} options={options(TEXT_SIZES, { s: 'S', m: 'M', l: 'L' })} onChange={(size) => choose('size', size)} />
      </Prop>
      {one && <ShapeLink diagram={diagram} shape={one} />}
      <footer className="insp-foot">
        {one && !one.link && <Promote diagram={diagram} shape={one} label={shapeLabel(model, one)} />}
        <span className="foot-spacer" />
        <Tip label={shapes.length === 1 ? 'Delete shape' : 'Delete shapes'} keys="⌫" side="top">
          <button type="button" className="foot-btn is-danger" aria-label="Delete" onClick={() => removeShapes(shapes.map((s) => s.id))}>
            <Trash size={14} strokeWidth={1.7} />
          </button>
        </Tip>
      </footer>
    </div>
  );
}

function ShapeText({ diagram, shape }: { diagram: Diagram; shape: DiagramShape }) {
  const live = useStore((s) => (shape.link ? linkName(s.model, shape.link) : undefined));
  return (
    <>
      <InlineText
        lineBreaks
        className="insp-name dshape-label"
        value={shape.text}
        placeholder={live ?? (shape.kind === 'group' ? 'Group title' : 'Text')}
        label="Text"
        maxLength={400}
        onCommit={(text) => setShapes(diagram, [{ id: shape.id, text }])}
      />
      <InlineText
        lineBreaks
        className="insp-summary"
        value={shape.detail ?? ''}
        placeholder="Detail, a quieter line below"
        label="Detail"
        maxLength={600}
        onCommit={(detail) => setShapes(diagram, [{ id: shape.id, detail: detail || null }])}
      />
    </>
  );
}

function ShapeLink({ diagram, shape }: { diagram: Diagram; shape: DiagramShape }) {
  const model = useStore((s) => s.model);
  const [picking, setPicking] = useState(false);
  const linkRef = useRef<HTMLButtonElement>(null);
  const link = shape.link;
  const name = link ? linkName(model, link) : undefined;
  const element = link?.type === 'element' ? model.elements.find((e) => e.id === link.id) : undefined;
  return (
    <Section
      label="Stands for"
      action={
        <button ref={linkRef} type="button" className="section-action" onClick={() => setPicking(true)}>
          <Link2 size={13} strokeWidth={1.8} aria-hidden />
          {link ? 'Change' : 'Link'}
        </button>
      }
    >
      {link ? (
        <div className="rel-row-wrap">
          <button type="button" className="rel-row" onClick={() => openLink(link)}>
            {element ? <KindIcon kind={element.kind} size={13} className="rel-kind" /> : <LinkIcon type={link.type as 'flow' | 'diagram'} />}
            <span className="rel-text">
              <span className="rel-name">{name ?? link.id}</span> <span className="rel-verb">{element ? KIND_LABEL[element.kind].toLowerCase() : link.type}</span>
            </span>
            <ArrowUpRight size={13} strokeWidth={1.7} className="rel-dir" aria-hidden />
          </button>
          <Tip label="Unlink, keeping the name" side="left">
            <button type="button" className="row-remove" aria-label="Unlink" onClick={() => setShapes(diagram, [{ id: shape.id, link: null, text: unlinkShape(shape, name).text }])}>
              <Unlink size={13} strokeWidth={1.8} />
            </button>
          </Tip>
        </div>
      ) : (
        <p className="insp-note">A drawing only. Link it to show an element, flow or diagram by its live name.</p>
      )}
      {picking && (
        <Picker
          anchor={linkRef}
          placeholder="Element, flow or diagram"
          items={linkItems(model, diagram.id)}
          onClose={() => setPicking(false)}
          onPick={(item) => setShapes(diagram, [{ id: shape.id, link: parseLinkItem(item.id), text: '' }])}
        />
      )}
    </Section>
  );
}

function Promote({ diagram, shape, label }: { diagram: Diagram; shape: DiagramShape; label: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const preferred = promotedKind(shape.kind);
  const kinds: ElementKind[] = [preferred, ...[...STRUCTURE_KINDS, 'data' as const].filter((k) => k !== preferred)];
  const name = label.split('\n').map((l) => l.trim()).find(Boolean);
  return (
    <>
      <Tip label={name ? `Create ${name} in the model and link this shape to it` : 'Give the shape text first'} side="top">
        <button ref={ref} type="button" className="foot-btn" disabled={!name} aria-haspopup="menu" onClick={() => setOpen(true)}>
          <Sparkles size={14} strokeWidth={1.7} aria-hidden />
          Make this an element…
        </button>
      </Tip>
      {open && (
        <Menu
          anchor={ref}
          onClose={() => setOpen(false)}
          items={kinds.map((k) => ({ label: KIND_LABEL[k], onSelect: () => makeElement(diagram, shape.id, k) }))}
        />
      )}
    </>
  );
}

// ─── Connectors ─────────────────────────────────────────────────────────────

function ConnectorInspector({ diagram, connectors, theme }: { diagram: Diagram; connectors: DiagramConnector[]; theme: DiagramTheme }) {
  const model = useStore((s) => s.model);
  const one = connectors.length === 1 ? connectors[0]! : undefined;
  const choose = <K extends 'line' | 'ends' | 'route' | 'tone'>(key: K, value: NonNullable<DiagramConnector[K]>, fallback: NonNullable<DiagramConnector[K]>) =>
    setConnectors(
      diagram,
      connectors.flatMap((c) => {
        const next = value === fallback ? undefined : value;
        return next === c[key] ? [] : [{ id: c.id, [key]: next ?? null }];
      }),
    );
  const name = (id: string) => {
    const s = diagram.shapes.find((x) => x.id === id);
    return (s && shapeLabel(model, s).split('\n')[0]) || SHAPE_LABEL[s?.kind ?? 'box'];
  };
  const ends = one ? connectorEnds(model, diagram, one.id) : undefined;
  const related = ends && model.relations.some((r) => r.from === ends.from && r.to === ends.to);
  const pinned = connectors.some((c) => c.fromSide || c.toSide);

  return (
    <div className="inspector-body">
      <header className="insp-head">
        {one ? (
          <div className="endpoints">
            <span className="endpoint is-plain">{name(one.from)}</span>
            <ArrowRight size={14} strokeWidth={1.7} className="endpoint-arrow" aria-label="to" />
            <span className="endpoint is-plain">{name(one.to)}</span>
          </div>
        ) : (
          <h2 className="insp-multi">{plural(connectors.length, 'line')} selected</h2>
        )}
      </header>
      {one && (
        <InlineText
          className="insp-summary"
          value={one.label}
          placeholder="Label, what travels or happens"
          label="Label"
          maxLength={120}
          onCommit={(label) => setConnectors(diagram, [{ id: one.id, label }])}
        />
      )}
      <Prop label="Line">
        <Segmented label="Line" value={(common(connectors.map((c) => c.line ?? 'solid')) ?? '') as (typeof LINE_STYLES)[number]} options={options(LINE_STYLES)} onChange={(v) => choose('line', v, 'solid')} />
      </Prop>
      <Prop label="Ends">
        <Segmented
          label="Ends"
          value={(common(connectors.map((c) => c.ends ?? 'arrow')) ?? '') as (typeof CONNECTOR_ENDS)[number]}
          options={options(CONNECTOR_ENDS, { arrow: 'Arrow', both: 'Both', none: 'None' })}
          onChange={(v) => choose('ends', v, 'arrow')}
        />
      </Prop>
      <Prop label="Route">
        <Segmented label="Route" value={(common(connectors.map((c) => c.route ?? 'elbow')) ?? '') as (typeof CONNECTOR_ROUTES)[number]} options={options(CONNECTOR_ROUTES)} onChange={(v) => choose('route', v, 'elbow')} />
      </Prop>
      <Prop label="Tone">
        <Swatches value={common(connectors.map((c) => c.tone ?? 'neutral'))} onChange={(tone) => choose('tone', tone, 'neutral')} theme={theme} />
      </Prop>
      {(one || pinned) && (
        <div className="dprop-actions">
          {one && (
            <button type="button" className="foot-btn" onClick={() => reverseConnector(diagram, one)}>
              <ArrowLeftRight size={14} strokeWidth={1.7} aria-hidden />
              Reverse
            </button>
          )}
          {pinned && (
            <Tip label="Let the line choose the sides that face each other" side="top">
              <button type="button" className="foot-btn" onClick={() => setConnectors(diagram, connectors.map((c) => ({ id: c.id, fromSide: null, toSide: null })))}>
                Unpin sides
              </button>
            </Tip>
          )}
        </div>
      )}
      {one && ends && (
        <p className="insp-note dprop-model">
          {related ? (
            'The model relates these two in this direction.'
          ) : (
            <button type="button" className="foot-btn" onClick={() => makeRelation(diagram, one.id)}>
              <Sparkles size={14} strokeWidth={1.7} aria-hidden />
              Make this a relation
            </button>
          )}
        </p>
      )}
      <footer className="insp-foot">
        <span className="foot-spacer" />
        <Tip label={connectors.length === 1 ? 'Delete line' : 'Delete lines'} keys="⌫" side="top">
          <button type="button" className="foot-btn is-danger" aria-label="Delete" onClick={() => removeShapes(connectors.map((c) => c.id))}>
            <Trash size={14} strokeWidth={1.7} />
          </button>
        </Tip>
      </footer>
    </div>
  );
}
