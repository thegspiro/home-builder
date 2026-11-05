/** A house shaped like a freshly created one: one area per seeded area type. */
import type { HouseArea, HouseDetail, HouseItem } from '../src/lib/types';

const SEEDED: [slug: string, name: string, zone: string][] = [
  ['kitchen', 'Kitchen', 'kitchen'],
  ['bathroom', 'Bathroom', 'bathroom'],
  ['bedroom', 'Bedroom', 'bedroom'],
  ['living-room', 'Living room', 'living-room'],
  ['laundry', 'Laundry', 'laundry'],
  ['basement', 'Basement', 'basement'],
  ['attic', 'Attic', 'attic'],
  ['garage', 'Garage', 'garage'],
  ['roof-gutters', 'Roof & gutters', 'roof'],
  ['siding-windows', 'Siding & windows', 'walls'],
  ['exterior-doors', 'Exterior doors', 'walls'],
  ['deck-porch', 'Deck/porch', 'deck'],
  ['foundation', 'Foundation', 'foundation'],
  ['driveway', 'Driveway', 'driveway'],
  ['yard', 'Yard/landscaping', 'yard'],
  ['tools', 'Tools', 'shed'],
  ['safety', 'Safety', 'shed'],
  ['general-skills', 'General skills', 'shed'],
];

export function area(
  id: number,
  name: string,
  zone: string,
  extra: Partial<HouseArea> = {},
): HouseArea {
  return {
    id,
    name,
    areaTypeId: id,
    areaTypeSlug: null,
    zone,
    hidden: false,
    sortOrder: id,
    ...extra,
  };
}

export function item(
  id: number,
  slug: string,
  areaIds: number[],
  extra: Partial<HouseItem> = {},
): HouseItem {
  return {
    id,
    slug,
    name: slug,
    system: null,
    wholeHouse: false,
    hidden: false,
    areaIds,
    ...extra,
  };
}

export function seededHouse(): HouseDetail {
  const areas = SEEDED.map(([slug, name, zone], i) =>
    area(i + 1, name, zone, { areaTypeSlug: slug }),
  );
  const id = (slug: string) => areas.find((a) => a.areaTypeSlug === slug)!.id;
  return {
    id: 1,
    name: 'Maple St',
    role: 'owner',
    areas,
    items: [
      item(1, 'electrical-panel', [id('garage')], { system: 'electrical' }),
      item(2, 'garage-door', [id('garage')]),
      item(3, 'water-heater', [id('garage')], { system: 'plumbing' }),
      item(4, 'furnace', [id('basement')], { system: 'hvac' }),
      item(5, 'water-main-shutoff', [id('basement')], { system: 'plumbing' }),
      item(6, 'kitchen-sink-faucet', [id('kitchen')], { system: 'plumbing' }),
      item(7, 'gfci-outlets', [id('bathroom')], { system: 'electrical' }),
      item(8, 'well-pump', [id('yard')], { system: 'plumbing', hidden: true }),
      item(9, 'thermostat', [], { system: 'hvac', wholeHouse: true }),
      item(10, 'shingles', [id('roof-gutters')]),
    ],
  };
}
