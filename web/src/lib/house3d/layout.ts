/**
 * Where everything sits in the 3D house (docs/PLAN.md section 7: 3D house).
 * Pure geometry, no Three.js, so it can be unit tested.
 *
 * Axes: x to the right, y up, z towards the viewer (the street). One unit is about a
 * metre. The main floor is at y = 0, the basement below it, the attic above.
 *
 * Every zone has a fixed slot (a box). When a house has several areas in one zone
 * (two areas drawn on the outside walls, three workshop areas in the shed, a custom
 * "Mudroom" added to the laundry zone…), the slot is split into equal side-by-side
 * parts, one per area, in the house's sort order.
 */
import type { HouseArea, HouseDetail, HouseItem } from '../types';
import { HOUSE_ZONES } from '../types';

export type HouseZone = (typeof HOUSE_ZONES)[number];
export type View = 'outside' | 'attic' | 'main' | 'basement';

/** Camera "levels": each shows the zones drawn at that level, so nothing hides them. */
export const VIEWS: readonly { id: View; label: string }[] = [
  { id: 'outside', label: 'Outside' },
  { id: 'attic', label: 'Attic' },
  { id: 'main', label: 'Main floor' },
  { id: 'basement', label: 'Basement' },
];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

/**
 * room: a floor with low walls (a dollhouse cutaway you can look into);
 * shell: full-height outside walls; roof: a gable; slab: a flat surface.
 */
export type ZoneStyle = 'room' | 'shell' | 'roof' | 'slab';
export type ZoneGroup = 'inside' | 'outside' | 'workshop';

export interface ZoneSpec {
  box: Box;
  style: ZoneStyle;
  group: ZoneGroup;
  views: readonly View[];
  /** Height of the cutaway walls for "room" zones. */
  wallHeight: number;
  /**
   * Where the row of items sits across the area, as a fraction of its depth
   * (0 = back, 1 = front; above 1 is in front of the front face).
   */
  itemAcross: number;
  /** Height of the bottom of the item row. */
  itemBase: 'floor' | 'middle' | 'top';
}

/** Height of the main floor's ceiling. */
export const STOREY = 2.6;
export const FLOOR_THICKNESS = 0.1;
/** Overlay lines (wires, pipes, ducts) run through the joists under the main floor. */
export const TRUNK_Y = -0.15;
const ITEM_SIZE = 0.45;

/**
 * Starting camera: looking at the house from the front right, high enough that the
 * cutaway walls of the front rooms don't hide the floors of the rooms behind them.
 */
export const CAMERA_TARGET: Vec3 = { x: 4, y: 0, z: 6 };
export const CAMERA_OFFSET: Vec3 = { x: 6, y: 17, z: 22 };

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Box {
  return { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } };
}

const GROUNDS: readonly View[] = ['outside', 'attic', 'main'];

function room(b: Box, views: readonly View[] = ['main']): ZoneSpec {
  return {
    box: b,
    style: 'room',
    group: 'inside',
    views,
    wallHeight: 0.9,
    itemAcross: 0.15,
    itemBase: 'floor',
  };
}

/** The house body is x 0–12, z 0–8; the attached garage is x 12–18. */
export const ZONES: Readonly<Record<HouseZone, ZoneSpec>> = {
  'living-room': room(box(0, 0, 4, 6, STOREY, 8)),
  kitchen: room(box(0, 0, 0, 6, STOREY, 4)),
  bedroom: room(box(6, 0, 4, 12, STOREY, 8)),
  bathroom: room(box(6, 0, 0, 9, STOREY, 4)),
  laundry: room(box(9, 0, 0, 12, STOREY, 4)),
  garage: room(box(12, 0, 0, 18, STOREY, 8)),
  basement: room(box(0, -2.4, 0, 12, 0, 8), ['basement']),
  attic: room(box(0, STOREY, 0, 12, STOREY + 2.2, 8), ['attic']),
  roof: {
    box: box(-0.4, STOREY, -0.5, 18.4, STOREY + 2.6, 8.5),
    style: 'roof',
    group: 'outside',
    views: ['outside'],
    wallHeight: 0,
    itemAcross: 0.5,
    itemBase: 'top',
  },
  walls: {
    box: box(0, 0, 0, 18, STOREY, 8),
    style: 'shell',
    group: 'outside',
    views: ['outside'],
    wallHeight: STOREY,
    itemAcross: 1.03,
    itemBase: 'middle',
  },
  foundation: {
    box: box(-0.15, -0.6, -0.15, 18.15, 0, 8.15),
    style: 'shell',
    group: 'outside',
    views: ['outside'],
    wallHeight: 0.6,
    itemAcross: 1.05,
    itemBase: 'floor',
  },
  deck: {
    box: box(-4, 0, 1, -0.2, 0.3, 7),
    style: 'slab',
    group: 'outside',
    views: GROUNDS,
    wallHeight: 0,
    itemAcross: 0.5,
    itemBase: 'top',
  },
  driveway: {
    box: box(12.5, 0, 8.6, 17.5, 0.04, 16),
    style: 'slab',
    group: 'outside',
    views: GROUNDS,
    wallHeight: 0,
    itemAcross: 0.5,
    itemBase: 'top',
  },
  yard: {
    box: box(-10, 0, 8.6, 12, 0.02, 16),
    style: 'slab',
    group: 'outside',
    views: GROUNDS,
    wallHeight: 0,
    itemAcross: 0.12,
    itemBase: 'top',
  },
  shed: {
    // Deeper than wide, so its areas (tools, safety, general skills) sit front to back
    // and their labels don't overlap.
    ...room(box(-9.5, 0, -2.5, -5, 2.2, 6.5), GROUNDS),
    group: 'workshop',
    // Low walls: the shed is seen at a shallow angle, and its areas sit side by side.
    wallHeight: 0.45,
  },
};

export function isHouseZone(zone: string): zone is HouseZone {
  return (HOUSE_ZONES as readonly string[]).includes(zone);
}

export function center(b: Box): Vec3 {
  return {
    x: (b.min.x + b.max.x) / 2,
    y: (b.min.y + b.max.y) / 2,
    z: (b.min.z + b.max.z) / 2,
  };
}

/** Splits a box into n equal parts along its longer horizontal side. */
export function splitBox(b: Box, n: number): Box[] {
  if (n <= 1) return [b];
  const alongX = b.max.x - b.min.x >= b.max.z - b.min.z;
  const axis = alongX ? 'x' : 'z';
  const step = (b.max[axis] - b.min[axis]) / n;
  return Array.from({ length: n }, (_, i) => {
    const part: Box = { min: { ...b.min }, max: { ...b.max } };
    part.min[axis] = b.min[axis] + step * i;
    part.max[axis] = i === n - 1 ? b.max[axis] : b.min[axis] + step * (i + 1);
    return part;
  });
}

export interface AreaLayout {
  area: HouseArea;
  zone: HouseZone;
  spec: ZoneSpec;
  box: Box;
  /** Where the area's name is shown, on the surface you click. */
  label: Vec3;
}

export interface ItemLayout {
  item: HouseItem;
  areaId: number;
  position: Vec3;
  size: number;
}

export interface HouseLayout {
  areas: AreaLayout[];
  items: ItemLayout[];
}

function labelPoint(spec: ZoneSpec, b: Box): Vec3 {
  const c = center(b);
  switch (spec.style) {
    case 'room':
      return { x: c.x, y: b.min.y + FLOOR_THICKNESS + 0.02, z: c.z };
    case 'slab':
      return { x: c.x, y: b.max.y + 0.02, z: c.z };
    case 'shell':
      return { x: c.x, y: c.y, z: b.max.z + 0.02 };
    case 'roof':
      // On the front slope, halfway up.
      return { x: c.x, y: (b.min.y + b.max.y) / 2, z: (c.z + b.max.z) / 2 };
  }
}

/** Positions of `count` items in a row along the area's longer side. */
export function itemRow(spec: ZoneSpec, b: Box, count: number): { points: Vec3[]; size: number } {
  const width = b.max.x - b.min.x;
  const depth = b.max.z - b.min.z;
  const alongX = width >= depth;
  const length = alongX ? width : depth;
  const span = alongX ? depth : width;
  const size = Math.min(ITEM_SIZE, (length * 0.8) / Math.max(count, 1) - 0.05);
  const base =
    spec.itemBase === 'floor'
      ? b.min.y + FLOOR_THICKNESS
      : spec.itemBase === 'middle'
        ? (b.min.y + b.max.y) / 2 - size / 2
        : b.max.y;
  const across = (alongX ? b.min.z : b.min.x) + span * spec.itemAcross;
  const points = Array.from({ length: count }, (_, i) => {
    const along = (alongX ? b.min.x : b.min.z) + length * (0.1 + (0.8 * (i + 0.5)) / count);
    return alongX
      ? { x: along, y: base + size / 2, z: across }
      : { x: across, y: base + size / 2, z: along };
  });
  return { points, size };
}

/**
 * Lays out the visible areas of a house and the items placed in them. Hidden areas and
 * items are left out, and so are whole-house items: they belong to every room, so they
 * are listed beside the model rather than drawn.
 */
export function layoutHouse(house: Pick<HouseDetail, 'areas' | 'items'>): HouseLayout {
  const byZone = new Map<HouseZone, HouseArea[]>();
  for (const area of house.areas) {
    if (area.hidden || !isHouseZone(area.zone)) continue;
    const list = byZone.get(area.zone) ?? [];
    list.push(area);
    byZone.set(area.zone, list);
  }

  const areas: AreaLayout[] = [];
  for (const zone of HOUSE_ZONES) {
    const list = byZone.get(zone);
    if (!list) continue;
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    const spec = ZONES[zone];
    splitBox(spec.box, list.length).forEach((part, i) => {
      const area = list[i];
      if (area) areas.push({ area, zone, spec, box: part, label: labelPoint(spec, part) });
    });
  }

  const items: ItemLayout[] = [];
  for (const placed of areas) {
    const here = house.items.filter(
      (item) => !item.hidden && !item.wholeHouse && item.areaIds.includes(placed.area.id),
    );
    if (here.length === 0) continue;
    const row = itemRow(placed.spec, placed.box, here.length);
    here.forEach((item, i) => {
      const position = row.points[i];
      if (position) items.push({ item, areaId: placed.area.id, position, size: row.size });
    });
  }
  return { areas, items };
}

/** Systems drawn as overlays, and the item each one starts from when it is placed. */
export const OVERLAYS = [
  { system: 'electrical', label: 'Wiring', hub: 'electrical-panel', everyRoom: true },
  { system: 'plumbing', label: 'Pipes', hub: 'water-main-shutoff', everyRoom: false },
  { system: 'hvac', label: 'Ducts', hub: 'furnace', everyRoom: true },
] as const;

export type OverlaySystem = (typeof OVERLAYS)[number]['system'];

function route(from: Vec3, to: Vec3): Vec3[] {
  return [
    from,
    { x: from.x, y: TRUNK_Y, z: from.z },
    { x: to.x, y: TRUNK_Y, z: from.z },
    { x: to.x, y: TRUNK_Y, z: to.z },
    to,
  ];
}

/**
 * Lines for one system overlay, as polylines. They start at the system's hub (the main
 * panel, the water shutoff or the furnace, wherever this house placed it; otherwise its
 * placed item with the lowest id) and run through the floor joists to each of the system's items.
 * Wiring and ducts also branch to every inside room (outlets and vents are everywhere).
 */
export function overlayRoutes(layout: HouseLayout, system: OverlaySystem): Vec3[][] {
  const overlay = OVERLAYS.find((o) => o.system === system);
  if (!overlay) return [];
  const members = layout.items.filter((placed) => placed.item.system === system);
  const hub =
    members.find((placed) => placed.item.slug === overlay.hub) ??
    [...members].sort((a, b) => a.item.id - b.item.id)[0];
  if (!hub) return [];

  const ends: Vec3[] = members.filter((m) => m !== hub).map((m) => m.position);
  if (overlay.everyRoom) {
    for (const placed of layout.areas) {
      if (placed.spec.group !== 'inside' || placed.area.id === hub.areaId) continue;
      const c = center(placed.box);
      ends.push({ x: c.x, y: placed.box.min.y + FLOOR_THICKNESS + 0.3, z: c.z });
    }
  }
  return ends.map((end) => route(hub.position, end));
}

/** The view an area is drawn in when it is opened from the menu. */
export function viewFor(placed: AreaLayout, current: View): View {
  return placed.spec.views.includes(current) ? current : (placed.spec.views[0] ?? current);
}
