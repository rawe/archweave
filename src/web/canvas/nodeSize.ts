/**
 * Sizes of structure nodes from their text, for layout before a node has been
 * rendered and as a floor afterwards (a summary may be hidden right now, but
 * positions must suit the full node). Chips get exactly the width computed here.
 */
import type { Element } from '../../shared/model.ts';
import { canvasMeasure, lineCount, SANS } from '../lib/text.ts';

export const INSIDE_W = 188;
const TEXT_W = INSIDE_W - 2 - 24 - 22; // border, padding, kind icon
const CHIP_MIN = 64;
const CHIP_MAX = 150;
const CHIP_PAD = 2 + 22;
const CHIP_FONT = `500 12px ${SANS}`;

/** Width of a neighbor chip: the name on one line where it fits, wrapping beyond that. */
export function chipWidth(name: string): number {
  const w = Math.ceil(canvasMeasure.width(name, CHIP_FONT)) + CHIP_PAD + 4;
  return Math.max(CHIP_MIN, Math.min(CHIP_MAX, w));
}

export function chipHeight(name: string): number {
  return 10 + 2 + lineCount(name, CHIP_FONT, chipWidth(name) - CHIP_PAD) * 16;
}

/** Height of an inside node showing its name and full summary. */
export function insideHeight(el: Element): number {
  const nameLines = lineCount(el.name, `560 13px ${SANS}`, TEXT_W);
  const summaryLines = el.summary ? lineCount(el.summary, `400 12px ${SANS}`, TEXT_W) : 0;
  return 2 + 21 + nameLines * 18 + (summaryLines ? 4 + Math.ceil(summaryLines * 17.04) : 0);
}
