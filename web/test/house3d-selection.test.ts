import { describe, expect, it } from 'vitest';
import {
  formatSelection,
  parseSelection,
  parseView,
  sameSelection,
  type Selection,
} from '../src/lib/house3d/selection';

describe('selection in the URL', () => {
  it('round-trips every kind', () => {
    const cases: Selection[] = [
      { kind: 'area', areaId: 12 },
      { kind: 'item', itemId: 5, areaId: 12 },
      { kind: 'item', itemId: 5, areaId: null },
      { kind: 'system', areaTypeId: 3 },
    ];
    for (const selection of cases) {
      expect(parseSelection(formatSelection(selection))).toEqual(selection);
    }
  });

  it('rejects anything else', () => {
    for (const bad of [
      null,
      '',
      'area',
      'area:',
      'area:0',
      'area:-1',
      'area:1.5',
      'area:12@3',
      'system:4@1',
      'room:3',
      'area:12345678901',
      'item:5@',
      ' area:1',
    ]) {
      expect(parseSelection(bad)).toBeNull();
    }
  });

  it('compares selections', () => {
    expect(sameSelection({ kind: 'area', areaId: 1 }, { kind: 'area', areaId: 1 })).toBe(true);
    expect(sameSelection({ kind: 'area', areaId: 1 }, { kind: 'system', areaTypeId: 1 })).toBe(
      false,
    );
    expect(sameSelection(null, null)).toBe(true);
    expect(sameSelection(null, { kind: 'area', areaId: 1 })).toBe(false);
  });

  it('accepts only known views', () => {
    expect(parseView('basement')).toBe('basement');
    expect(parseView('roof')).toBeNull();
    expect(parseView(null)).toBeNull();
  });
});
