import { describe, expect, it } from 'vitest';
import {
  ZONES,
  center,
  layoutHouse,
  overlayRoutes,
  splitBox,
  viewFor,
  type Box,
} from '../src/lib/house3d/layout';
import { area, item, seededHouse } from './house3d-fixture';

function inside(outer: Box, inner: Box): boolean {
  const eps = 1e-9;
  return (['x', 'y', 'z'] as const).every(
    (k) => inner.min[k] >= outer.min[k] - eps && inner.max[k] <= outer.max[k] + eps,
  );
}

function footprintContains(b: Box, p: { x: number; z: number }): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.z >= b.min.z && p.z <= b.max.z;
}

describe('splitBox', () => {
  it('splits along the longer horizontal side into equal parts that cover the box', () => {
    const wide: Box = { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 2, z: 3 } };
    const parts = splitBox(wide, 3);
    expect(parts.map((p) => [p.min.x, p.max.x])).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
    ]);
    expect(parts.every((p) => p.min.z === 0 && p.max.z === 3)).toBe(true);

    const deep: Box = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 1, z: 8 } };
    expect(splitBox(deep, 2).map((p) => [p.min.z, p.max.z])).toEqual([
      [0, 4],
      [4, 8],
    ]);
    expect(splitBox(deep, 1)).toEqual([deep]);
  });
});

describe('layoutHouse', () => {
  it('draws every visible area inside its zone slot', () => {
    const house = seededHouse();
    const layout = layoutHouse(house);
    expect(layout.areas).toHaveLength(house.areas.length);
    for (const placed of layout.areas) {
      expect(inside(ZONES[placed.zone].box, placed.box)).toBe(true);
    }
  });

  it('gives areas that share a zone side-by-side parts in sort order', () => {
    const layout = layoutHouse(seededHouse());
    const shed = layout.areas.filter((a) => a.zone === 'shed');
    expect(shed.map((a) => a.area.name)).toEqual(['Tools', 'Safety', 'General skills']);
    const [first, second, third] = shed.map((a) => a.box);
    expect(first!.max.z).toBeCloseTo(second!.min.z);
    expect(second!.max.z).toBeCloseTo(third!.min.z);
    expect(first!.min.z).toBe(ZONES.shed.box.min.z);
    expect(third!.max.z).toBe(ZONES.shed.box.max.z);

    const walls = layout.areas.filter((a) => a.zone === 'walls');
    expect(walls.map((a) => a.area.name)).toEqual(['Siding & windows', 'Exterior doors']);
  });

  it('leaves out hidden areas and makes room for custom ones', () => {
    const house = seededHouse();
    house.areas = [
      area(1, 'Laundry', 'laundry', { sortOrder: 2 }),
      area(2, 'Mudroom', 'laundry', { sortOrder: 1, areaTypeId: null }),
      area(3, 'Deck', 'deck', { hidden: true }),
    ];
    house.items = [];
    const layout = layoutHouse(house);
    expect(layout.areas.map((a) => a.area.name)).toEqual(['Mudroom', 'Laundry']);
    // The laundry slot is deeper than it is wide, so it is split front to back.
    const [mudroom, laundry] = layout.areas.map((a) => a.box);
    expect(mudroom!.max.z).toBeCloseTo(laundry!.min.z);
    expect(mudroom!.min.z).toBe(ZONES.laundry.box.min.z);
    expect(laundry!.max.z).toBe(ZONES.laundry.box.max.z);
  });

  it('ignores areas whose zone the model does not know', () => {
    const house = seededHouse();
    house.areas = [area(1, 'Odd', 'overlay'), area(2, 'Kitchen', 'kitchen')];
    house.items = [];
    expect(layoutHouse(house).areas.map((a) => a.area.name)).toEqual(['Kitchen']);
  });

  it('places items in their rooms and skips hidden and whole-house items', () => {
    const layout = layoutHouse(seededHouse());
    const slugs = layout.items.map((placed) => placed.item.slug);
    expect(slugs).not.toContain('well-pump');
    expect(slugs).not.toContain('thermostat');
    for (const placed of layout.items) {
      const room = layout.areas.find((a) => a.area.id === placed.areaId)!;
      if (room.spec.style === 'room' || room.spec.style === 'slab') {
        expect(footprintContains(room.box, placed.position)).toBe(true);
      }
    }
    const garage = layout.items.filter(
      (p) => p.areaId === layout.areas.find((a) => a.zone === 'garage')!.area.id,
    );
    const spots = garage.map((p) => `${p.position.x},${p.position.z}`);
    expect(new Set(spots).size).toBe(garage.length); // a row, not a pile
  });

  it('draws an item placed in two rooms in both', () => {
    const house = seededHouse();
    const garage = house.areas.find((a) => a.zone === 'garage')!.id;
    const basement = house.areas.find((a) => a.zone === 'basement')!.id;
    house.items = [item(1, 'electrical-panel', [garage, basement], { system: 'electrical' })];
    expect(
      layoutHouse(house)
        .items.map((p) => p.areaId)
        .sort(),
    ).toEqual([garage, basement].sort());
  });
});

describe('overlayRoutes', () => {
  it('runs wiring from the panel to every inside room and electrical item', () => {
    const house = seededHouse();
    const layout = layoutHouse(house);
    const garage = layout.areas.find((a) => a.zone === 'garage')!;
    const routes = overlayRoutes(layout, 'electrical');
    const panel = layout.items.find((p) => p.item.slug === 'electrical-panel')!;
    expect(routes.every((r) => r[0] === panel.position)).toBe(true);
    const insideRooms = layout.areas.filter(
      (a) => a.spec.group === 'inside' && a.area.id !== garage.area.id,
    ).length;
    // Every inside room except the panel's own, plus the bathroom GFCI outlets.
    expect(routes).toHaveLength(insideRooms + 1);
  });

  it('follows the panel when the house moves it to the basement', () => {
    const house = seededHouse();
    const basement = house.areas.find((a) => a.zone === 'basement')!;
    house.items[0]!.areaIds = [basement.id];
    const layout = layoutHouse(house);
    const start = overlayRoutes(layout, 'electrical')[0]![0]!;
    const basementBox = layout.areas.find((a) => a.area.id === basement.id)!.box;
    expect(footprintContains(basementBox, start)).toBe(true);
    expect(start.y).toBeLessThan(0);
  });

  it('runs pipes only to plumbing items, skipping hidden ones', () => {
    const layout = layoutHouse(seededHouse());
    const routes = overlayRoutes(layout, 'plumbing');
    const shutoff = layout.items.find((p) => p.item.slug === 'water-main-shutoff')!;
    expect(routes.every((r) => r[0] === shutoff.position)).toBe(true);
    // Water heater and kitchen sink; the well pump is hidden.
    expect(routes.map((r) => r.at(-1))).toEqual(
      layout.items
        .filter((p) => p.item.system === 'plumbing' && p !== shutoff)
        .map((p) => p.position),
    );
    expect(routes).toHaveLength(2);
  });

  it('falls back to the placed item with the lowest id, and draws nothing without one', () => {
    const house = seededHouse();
    house.items = house.items.filter((i) => i.slug !== 'water-main-shutoff');
    const layout = layoutHouse(house);
    const heater = layout.items.find((p) => p.item.slug === 'water-heater')!;
    expect(overlayRoutes(layout, 'plumbing')[0]![0]).toBe(heater.position);

    house.items = [];
    expect(overlayRoutes(layoutHouse(house), 'hvac')).toEqual([]);
  });

  it('routes through the floor joists between rooms', () => {
    const layout = layoutHouse(seededHouse());
    for (const r of overlayRoutes(layout, 'hvac')) {
      expect(r).toHaveLength(5);
      expect(r.slice(1, 4).every((p) => p.y === -0.15)).toBe(true);
    }
  });
});

describe('viewFor', () => {
  it('keeps the current view when the area is drawn there, else uses its own', () => {
    const layout = layoutHouse(seededHouse());
    const yard = layout.areas.find((a) => a.zone === 'yard')!;
    const basement = layout.areas.find((a) => a.zone === 'basement')!;
    expect(viewFor(yard, 'main')).toBe('main');
    expect(viewFor(yard, 'basement')).toBe('outside');
    expect(viewFor(basement, 'outside')).toBe('basement');
    expect(center(basement.box).y).toBeLessThan(0);
  });
});
