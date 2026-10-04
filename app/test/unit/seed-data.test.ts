import { describe, expect, it } from 'vitest';
import { AREA_TYPES, ITEMS, TAGS } from '../../src/db/seed-data.js';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function duplicates(values: readonly string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) !== i);
}

describe('seed catalog', () => {
  const areaSlugs = new Set(AREA_TYPES.map((a) => a.slug));
  const systemSlugs = new Set(AREA_TYPES.filter((a) => a.category === 'system').map((a) => a.slug));

  it('has unique, well-formed slugs', () => {
    for (const list of [AREA_TYPES, ITEMS, TAGS]) {
      const slugs = list.map((x) => x.slug);
      expect(duplicates(slugs)).toEqual([]);
      for (const slug of slugs) {
        expect(slug).toMatch(SLUG_RE);
        expect(slug.length).toBeLessThanOrEqual(64);
      }
    }
  });

  it('places every item in known, non-system areas', () => {
    for (const item of ITEMS) {
      for (const area of item.defaultAreas) {
        expect(areaSlugs.has(area), `${item.slug} → ${area}`).toBe(true);
        expect(systemSlugs.has(area), `${item.slug} placed in a system`).toBe(false);
      }
    }
  });

  it('links items only to system area types', () => {
    for (const item of ITEMS) {
      if (item.system !== undefined) {
        expect(systemSlugs.has(item.system), `${item.slug} → ${item.system}`).toBe(true);
      }
    }
  });

  it('has a placement for every item that is not whole-house, and none for whole-house items', () => {
    for (const item of ITEMS) {
      if (item.wholeHouse) {
        expect(item.defaultAreas, item.slug).toEqual([]);
      } else {
        expect(item.defaultAreas.length, item.slug).toBeGreaterThan(0);
      }
    }
  });

  it('covers every category from the plan', () => {
    expect(new Set(AREA_TYPES.map((a) => a.category))).toEqual(
      new Set(['interior', 'exterior', 'system', 'workshop']),
    );
    expect(new Set(TAGS.map((t) => t.kind))).toEqual(
      new Set(['task', 'skill', 'topic', 'trade', 'tools']),
    );
  });
});
