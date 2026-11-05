/**
 * What the 3D page is showing videos for, kept in the URL (?select=…&view=…) so a
 * link opens the same room. Values: "area:12", "item:5@12" (item 5 in area 12),
 * "item:5" (a whole-house item) and "system:3" (a system area type).
 */
import { VIEWS, type View } from './layout';

export type Selection =
  | { kind: 'area'; areaId: number }
  | { kind: 'item'; itemId: number; areaId: number | null }
  | { kind: 'system'; areaTypeId: number };

const PATTERN = /^(area|item|system):([1-9]\d{0,9})(?:@([1-9]\d{0,9}))?$/;

export function parseSelection(value: string | null): Selection | null {
  const match = value ? PATTERN.exec(value) : null;
  if (!match) return null;
  const [, kind, rawId, rawArea] = match;
  const id = Number(rawId);
  if (kind === 'item') return { kind, itemId: id, areaId: rawArea ? Number(rawArea) : null };
  if (rawArea) return null;
  return kind === 'area' ? { kind, areaId: id } : { kind: 'system', areaTypeId: id };
}

export function formatSelection(selection: Selection): string {
  switch (selection.kind) {
    case 'area':
      return `area:${selection.areaId}`;
    case 'item':
      return selection.areaId === null
        ? `item:${selection.itemId}`
        : `item:${selection.itemId}@${selection.areaId}`;
    case 'system':
      return `system:${selection.areaTypeId}`;
  }
}

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === null || b === null) return a === b;
  return formatSelection(a) === formatSelection(b);
}

export function parseView(value: string | null): View | null {
  return VIEWS.find((v) => v.id === value)?.id ?? null;
}
