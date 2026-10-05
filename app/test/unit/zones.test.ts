import { describe, expect, it } from 'vitest';
import { AREA_TYPES } from '../../src/db/seed-data.js';
import { HOUSE_ZONES, isHouseZone, OVERLAY_ZONE } from '../../src/houses/zones.js';

describe('house zones', () => {
  it('cover every seeded room area type', () => {
    for (const area of AREA_TYPES) {
      if (area.category === 'system') {
        expect(area.zone, area.slug).toBe(OVERLAY_ZONE);
      } else {
        expect(isHouseZone(area.zone), `${area.slug} → ${area.zone}`).toBe(true);
      }
    }
  });

  it('never include the overlay zone', () => {
    expect(isHouseZone(OVERLAY_ZONE)).toBe(false);
    expect(new Set(HOUSE_ZONES).size).toBe(HOUSE_ZONES.length);
  });
});
