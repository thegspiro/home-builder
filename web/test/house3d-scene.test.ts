import { PerspectiveCamera, Raycaster, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_OFFSET,
  CAMERA_TARGET,
  layoutHouse,
  type HouseZone,
  type Vec3,
  type View,
} from '../src/lib/house3d/layout';
import { HouseScene } from '../src/lib/house3d/scene';
import { seededHouse } from './house3d-fixture';

/** Casts a ray from the starting camera position through a point, like a click there. */
function clickThrough(house: HouseScene, point: Vec3) {
  const camera = new PerspectiveCamera(45, 16 / 9, 0.1, 200);
  camera.position.set(
    CAMERA_TARGET.x + CAMERA_OFFSET.x,
    CAMERA_TARGET.y + CAMERA_OFFSET.y,
    CAMERA_TARGET.z + CAMERA_OFFSET.z,
  );
  const target = new Vector3(point.x, point.y, point.z);
  const raycaster = new Raycaster(camera.position, target.sub(camera.position).normalize());
  return house.pick(raycaster);
}

function setup(view: View) {
  const layout = layoutHouse(seededHouse());
  const house = new HouseScene(layout);
  house.setView(view);
  return { layout, house };
}

const MAIN_ZONES: HouseZone[] = [
  'kitchen',
  'living-room',
  'bedroom',
  'bathroom',
  'laundry',
  'garage',
  'deck',
  'driveway',
  'yard',
  'shed',
];

describe('HouseScene picking from the starting camera', () => {
  it('reaches every area on the main floor by clicking its label', () => {
    const { layout, house } = setup('main');
    for (const placed of layout.areas.filter((a) => MAIN_ZONES.includes(a.zone))) {
      expect(clickThrough(house, placed.label), placed.area.name).toEqual({
        kind: 'area',
        areaId: placed.area.id,
      });
    }
  });

  it('reaches the outside of the house in the outside view', () => {
    const { layout, house } = setup('outside');
    for (const placed of layout.areas.filter((a) =>
      ['walls', 'roof', 'foundation', 'yard', 'driveway'].includes(a.zone),
    )) {
      expect(clickThrough(house, placed.label), placed.area.name).toEqual({
        kind: 'area',
        areaId: placed.area.id,
      });
    }
  });

  it('reaches the basement and attic in their own views', () => {
    for (const view of ['basement', 'attic'] as const) {
      const { layout, house } = setup(view);
      const placed = layout.areas.find((a) => a.zone === view)!;
      expect(clickThrough(house, placed.label)).toEqual({ kind: 'area', areaId: placed.area.id });
    }
  });

  it('never picks areas the current view hides', () => {
    const { layout, house } = setup('outside');
    const kitchen = layout.areas.find((a) => a.zone === 'kitchen')!;
    expect(house.isAreaShown(kitchen.area.id)).toBe(false);
    expect(clickThrough(house, kitchen.label)).not.toEqual({
      kind: 'area',
      areaId: kitchen.area.id,
    });
  });

  it('picks items in their room', () => {
    const { layout, house } = setup('main');
    const panel = layout.items.find((p) => p.item.slug === 'electrical-panel')!;
    expect(clickThrough(house, panel.position)).toEqual({
      kind: 'item',
      areaId: panel.areaId,
      itemId: panel.item.id,
    });
  });
});

describe('HouseScene overlays and focus', () => {
  it('builds hidden overlay lines that can be switched on', () => {
    const { house } = setup('main');
    expect(house.overlayLineCount('electrical')).toBeGreaterThan(0);
    expect(house.overlayLineCount('plumbing')).toBe(2);
    const group = house.scene.children.find(
      (c) => c.type === 'Group' && c.children[0]?.type === 'Line',
    )!;
    expect(group.visible).toBe(false);
    house.setOverlay('electrical', true);
    house.setOverlay('plumbing', true);
    house.setOverlay('hvac', true);
    const lineGroups = house.scene.children.filter(
      (c) => c.type === 'Group' && c.children[0]?.type === 'Line',
    );
    expect(lineGroups.every((g) => g.visible)).toBe(true);
  });

  it('focuses on the floor of a room', () => {
    const { layout, house } = setup('main');
    const garage = layout.areas.find((a) => a.zone === 'garage')!;
    const focus = house.focus(garage.area.id)!;
    expect(focus.target.x).toBeCloseTo(15);
    expect(focus.target.y).toBeCloseTo(0.1);
    expect(focus.distance).toBeGreaterThanOrEqual(7);
    expect(house.focus(9999)).toBeNull();
  });
});
