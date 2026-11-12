/**
 * The deterministic layout of the data focus view: one structure in the
 * center with all its fields, the structures it references on the right, the
 * structures that reference it on the left, and the elements that touch it
 * below. Positions are computed from the model alone; nothing is stored.
 *
 * Nothing is shortened: every header and field row is as tall as its wrapped
 * text, so names and long types read in full and the cards grow to fit.
 */
import type { Element, Field, Model, Relation, RelationKind } from '../../shared/model.ts';
import { canvasMeasure, lineCount, MONO, SANS, type Measure } from '../lib/text.ts';

export const CENTER_W = 300;
export const SIDE_W = 212;
export const GAP = 56;
/** Height of a one-line field row. */
export const ROW = 28;
export const MORE = 28;
export const PAD = 6;
const LINE = 16;
const STACK = 12;
const USERS_GAP = 44;
/** How far below a header line a thread pointing back runs, so two opposite relations do not overlap. */
const BACK_OFFSET = 10;

const FONT = {
  centerName: `600 15px ${SANS}`,
  sideName: `560 13px ${SANS}`,
  owner: `400 12px ${SANS}`,
  field: `400 12px ${SANS}`,
  type: `400 11.5px ${MONO}`,
  format: `400 11px ${MONO}`,
  user: `500 12px ${SANS}`,
};

export interface FocusRow {
  index: number;
  field: Field;
  /** Top of the row, relative to the card. */
  y: number;
  h: number;
  /** The type did not fit beside the name and sits below it. */
  stacked: boolean;
}

export interface FocusCard {
  id: string;
  element: Element;
  role: 'center' | 'left' | 'right';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Header height, which grows with a long name. */
  head: number;
  /** Field rows shown on the card: all of them in the center, the linking ones (or all, when expanded) on the sides. */
  rows: FocusRow[];
  /** Fields not shown on a side card. */
  more: number;
  expanded: boolean;
  /** An expanded side card that also has fields beyond the linking ones offers to fold them again. */
  canCollapse: boolean;
}

export interface FocusThread {
  id: string;
  /** The side structure this thread belongs to; hovering either end lights it. */
  neighbor: string;
  /** Row index on the center card when the thread starts or ends at a center row. */
  centerRow?: number;
  /** Row index on the side card when the thread starts at a side row. */
  sideRow?: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Direction the arrow points at the end. */
  toward: 'left' | 'right';
  /** x of a shared vertical spine: threads converging on one header run along it instead of fanning out. */
  spine?: number;
  planned: boolean;
}

export interface UserItem {
  key: string;
  relationId: string;
  element: Element;
  /** For carried data: the element on the other end of the relation. */
  peer?: Element;
}

export interface UserGroup {
  label: string;
  items: UserItem[];
}

export interface FocusLayout {
  center: FocusCard;
  cards: FocusCard[];
  threads: FocusThread[];
  users: { x: number; y: number; w: number; groups: UserGroup[] } | null;
  bounds: { x: number; y: number; width: number; height: number };
}

export interface FocusOptions {
  /** Side structures whose card shows all fields. */
  expanded?: ReadonlySet<string>;
  measure?: Measure;
}

const USER_LABEL: Partial<Record<RelationKind, string>> = {
  produces: 'Produced by',
  writes: 'Written by',
  publishes: 'Published by',
  reads: 'Read by',
  consumes: 'Consumed by',
  subscribes: 'Received by',
};
const USER_ORDER = ['Produced by', 'Written by', 'Published by', 'Read by', 'Consumed by', 'Received by', 'Used by', 'Carried between'];

/**
 * Height of a field row: name and type on one line when they fit side by side,
 * otherwise the type moves below the name; either may wrap over several lines.
 */
export function rowHeight(field: Field, cardWidth: number, measure: Measure = canvasMeasure): number {
  const inner = cardWidth - 26 - (field.ref ? 20 : 0);
  const name = field.name + (field.optional ? '?' : '');
  const nameW = measure.width(name, FONT.field);
  const typeW = field.type ? measure.width(field.type, FONT.type) : 0;
  if (nameW + (typeW ? 12 + typeW : 0) <= inner - 3) return ROW;
  const nameLines = lineCount(name, FONT.field, inner, measure);
  const typeLines = field.type ? lineCount(field.type, FONT.type, inner - 12, measure) : 0;
  return 12 + (nameLines + typeLines) * LINE;
}

/** Header height of a card: the name wraps next to the format tag, the owner line below it on the center card. */
export function headHeight(el: Element, role: FocusCard['role'], owner: string | undefined, measure: Measure = canvasMeasure): number {
  const w = role === 'center' ? CENTER_W : SIDE_W;
  const format = el.format ? measure.width(el.format, FONT.format) + 12 + 7 : 0;
  if (role === 'center') {
    const nameLines = lineCount(el.name, FONT.centerName, w - 24 - 22 - format, measure);
    const ownerLines = owner ? lineCount(`in ${owner}`, FONT.owner, w - 24 - 23, measure) : 0;
    return Math.max(54, 20 + nameLines * 20 + ownerLines * 16);
  }
  const nameLines = lineCount(el.name, FONT.sideName, w - 24 - format, measure);
  return Math.max(40, 22 + nameLines * 18);
}

function rowsFor(el: Element, indices: number[], width: number, head: number, measure: Measure): FocusRow[] {
  let y = head + 3;
  return indices.map((index) => {
    const field = el.fields[index]!;
    const h = rowHeight(field, width, measure);
    const row = { index, field, y, h, stacked: h > ROW };
    y += h;
    return row;
  });
}

function cardHeight(card: Pick<FocusCard, 'role' | 'head' | 'rows' | 'more' | 'canCollapse'>): number {
  const rowsBottom = card.rows.length ? card.rows[card.rows.length - 1]!.y + card.rows[card.rows.length - 1]!.h : card.head + 3;
  if (card.role === 'center') return Math.max(rowsBottom, card.head + 3 + ROW) + PAD;
  if (!card.rows.length && !card.more) return card.head;
  return rowsBottom + (card.more > 0 || card.canCollapse ? MORE : 0) + PAD;
}

export function layoutFocus(model: Model, focusId: string, options: FocusOptions = {}): FocusLayout | null {
  const measure = options.measure ?? canvasMeasure;
  const expanded = options.expanded ?? new Set<string>();
  const byId = new Map(model.elements.map((e) => [e.id, e]));
  const center = byId.get(focusId);
  if (!center || center.kind !== 'data') return null;
  const isData = (id: string) => byId.get(id)?.kind === 'data';
  const dataRelation = (r: Relation) => isData(r.from) && isData(r.to) && r.from !== r.to;
  const ownerName = (el: Element) => (el.parentId ? byId.get(el.parentId)?.name : undefined);

  // What the center references: field refs (by row) and data-to-data relations.
  const outRows = new Map<string, number[]>();
  const outRelations = new Map<string, Relation>();
  center.fields.forEach((f, i) => {
    if (f.ref && f.ref !== center.id && isData(f.ref)) (outRows.get(f.ref) ?? outRows.set(f.ref, []).get(f.ref)!).push(i);
  });
  for (const r of model.relations) if (dataRelation(r) && r.from === center.id && !outRelations.has(r.to)) outRelations.set(r.to, r);

  // What references the center.
  const inRows = new Map<string, number[]>();
  const inRelations = new Map<string, Relation>();
  for (const el of model.elements) {
    if (el.kind !== 'data' || el.id === center.id) continue;
    el.fields.forEach((f, i) => {
      if (f.ref === center.id) (inRows.get(el.id) ?? inRows.set(el.id, []).get(el.id)!).push(i);
    });
  }
  for (const r of model.relations) if (dataRelation(r) && r.to === center.id && !inRelations.has(r.from)) inRelations.set(r.from, r);

  const centerHead = headHeight(center, 'center', ownerName(center), measure);
  const centerCard: FocusCard = {
    id: center.id,
    element: center,
    role: 'center',
    x: 0,
    y: 0,
    w: CENTER_W,
    h: 0,
    head: centerHead,
    rows: rowsFor(center, center.fields.map((_, i) => i), CENTER_W, centerHead, measure),
    more: 0,
    expanded: true,
    canCollapse: false,
  };
  centerCard.h = cardHeight(centerCard);
  const rowMid = (card: FocusCard, index: number) => {
    const row = card.rows.find((r) => r.index === index)!;
    return card.y + row.y + Math.min(row.h / 2, ROW / 2);
  };
  /** Threads meet a header at its first line, so they stay put when a name wraps. */
  const headY = (card: FocusCard) => card.y + Math.min(card.head / 2, card.role === 'center' ? 27 : 20);

  const sideCard = (id: string, role: 'left' | 'right', linking: number[]): FocusCard => {
    const el = byId.get(id)!;
    const open = expanded.has(id);
    const head = headHeight(el, role, undefined, measure);
    const indices = open ? el.fields.map((_, i) => i) : linking;
    const rows = rowsFor(el, indices, SIDE_W, head, measure);
    const card: FocusCard = { id, element: el, role, x: role === 'right' ? CENTER_W + GAP : -GAP - SIDE_W, y: 0, w: SIDE_W, h: 0, head, rows, more: el.fields.length - rows.length, expanded: open, canCollapse: open && linking.length < el.fields.length };
    card.h = cardHeight(card);
    return card;
  };

  // Right column: referenced structures, aligned with the first row that references each.
  const rightIds = [...new Set([...outRows.keys(), ...outRelations.keys()])];
  const firstRow = (id: string) => Math.min(...(outRows.get(id) ?? [Infinity]));
  rightIds.sort((a, b) => firstRow(a) - firstRow(b) || byId.get(a)!.name.localeCompare(byId.get(b)!.name));
  const right: FocusCard[] = [];
  let cursor = 0;
  for (const id of rightIds) {
    const card = sideCard(id, 'right', inRows.get(id) ?? []);
    const first = firstRow(id);
    const anchor = Number.isFinite(first) ? rowMid(centerCard, first) : headY(centerCard);
    card.y = Math.max(anchor - Math.min(card.head / 2, 20), cursor);
    right.push(card);
    cursor = card.y + card.h + STACK;
  }

  // Left column: structures referencing the center that are not already on the right.
  const leftIds = [...new Set([...inRows.keys(), ...inRelations.keys()])].filter((id) => !outRows.has(id) && !outRelations.has(id));
  leftIds.sort((a, b) => byId.get(a)!.name.localeCompare(byId.get(b)!.name) || a.localeCompare(b));
  const left = leftIds.map((id) => sideCard(id, 'left', inRows.get(id) ?? []));
  const leftHeight = Math.max(0, left.reduce((sum, c) => sum + c.h + STACK, 0) - STACK);
  let y = leftHeight < centerCard.h ? Math.round((centerCard.h - leftHeight) / 2) : 0;
  for (const card of left) {
    card.y = y;
    y += card.h + STACK;
  }

  // Threads, each from a field row (or a header) to the header of the structure it points at.
  const threads: FocusThread[] = [];
  const centerIn = { left: { x: 0, y: headY(centerCard) }, right: { x: CENTER_W, y: headY(centerCard) } };
  for (const card of right) {
    const head = { x: card.x, y: headY(card) };
    const rows = outRows.get(card.id) ?? [];
    for (const i of rows)
      threads.push({ id: `out:${i}`, neighbor: card.id, centerRow: i, from: { x: CENTER_W, y: rowMid(centerCard, i) }, to: head, toward: 'right', planned: center.status === 'planned' });
    const rel = outRelations.get(card.id);
    if (!rows.length && rel) threads.push({ id: `rel:${rel.id}`, neighbor: card.id, from: centerIn.right, to: head, toward: 'right', planned: rel.status === 'planned' });
    // A `references` relation back from a structure on the right: header to header, just below the outgoing thread.
    const back = inRelations.get(card.id);
    if (!inRows.get(card.id)?.length && back)
      threads.push({
        id: `rel:${back.id}`,
        neighbor: card.id,
        from: { x: card.x, y: headY(card) + BACK_OFFSET },
        to: { x: CENTER_W, y: centerIn.right.y + BACK_OFFSET },
        toward: 'left',
        planned: back.status === 'planned',
      });
    for (const index of inRows.get(card.id) ?? [])
      threads.push({
        id: `back:${card.id}:${index}`,
        neighbor: card.id,
        sideRow: index,
        from: { x: card.x, y: rowMid(card, index) },
        to: centerIn.right,
        toward: 'left',
        planned: card.element.status === 'planned',
      });
  }
  for (const card of left) {
    for (const index of inRows.get(card.id) ?? [])
      threads.push({
        id: `in:${card.id}:${index}`,
        neighbor: card.id,
        sideRow: index,
        from: { x: card.x + card.w, y: rowMid(card, index) },
        to: centerIn.left,
        toward: 'right',
        spine: -GAP / 2,
        planned: card.element.status === 'planned',
      });
    const rel = inRelations.get(card.id);
    if (!inRows.get(card.id)?.length && rel)
      threads.push({ id: `rel:${rel.id}`, neighbor: card.id, from: { x: card.x + card.w, y: headY(card) }, to: centerIn.left, toward: 'right', spine: -GAP / 2, planned: rel.status === 'planned' });
  }

  // Elements that touch the structure, grouped by verb.
  const groups = new Map<string, UserItem[]>();
  const add = (label: string, item: UserItem) => {
    const list = groups.get(label) ?? groups.set(label, []).get(label)!;
    if (!list.some((i) => i.key === item.key)) list.push(item);
  };
  for (const r of model.relations) {
    if (dataRelation(r)) continue;
    const other = r.from === center.id ? byId.get(r.to) : r.to === center.id ? byId.get(r.from) : undefined;
    if (other && other.kind !== 'data') add(USER_LABEL[r.kind] ?? 'Used by', { key: other.id, relationId: r.id, element: other });
    if (r.dataIds.includes(center.id)) {
      const a = byId.get(r.from);
      const b = byId.get(r.to);
      if (a && b && a.kind !== 'data' && b.kind !== 'data') add('Carried between', { key: `${a.id}>${b.id}`, relationId: r.id, element: a, peer: b });
    }
  }
  const userGroups = USER_ORDER.filter((label) => groups.has(label)).map((label) => ({
    label,
    items: groups.get(label)!.sort((p, q) => p.element.name.localeCompare(q.element.name) || (p.peer?.name ?? '').localeCompare(q.peer?.name ?? '')),
  }));
  const users = userGroups.length ? { x: 0, y: centerCard.h + USERS_GAP, w: CENTER_W, groups: userGroups } : null;

  const cards = [centerCard, ...left, ...right];
  const minX = left.length ? left[0]!.x : 0;
  const maxX = right.length ? CENTER_W + GAP + SIDE_W : CENTER_W;
  const usersHeight = users ? estimateUsersHeight(users.groups, measure) : 0;
  const maxY = Math.max(...cards.map((c) => c.y + c.h), users ? users.y + usersHeight : 0);
  return { center: centerCard, cards, threads, users, bounds: { x: minX, y: 0, width: maxX - minX, height: maxY } };
}

/** Height of the users block: chips flow in rows across the center column. */
function estimateUsersHeight(groups: UserGroup[], measure: Measure): number {
  let h = 0;
  for (const g of groups) {
    let rows = 1;
    let used = 0;
    for (const item of g.items) {
      const text = item.peer ? `${item.element.name} → ${item.peer.name}` : item.element.name;
      const w = Math.min(CENTER_W, measure.width(text, FONT.user) + 46);
      if (used && used + 6 + w > CENTER_W) {
        rows++;
        used = 0;
      }
      used += (used ? 6 : 0) + w;
    }
    h += 24 + rows * 32 + 12;
  }
  return h;
}
