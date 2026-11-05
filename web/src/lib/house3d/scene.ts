/**
 * Builds the Three.js scene from a house layout. Nothing here needs WebGL: meshes,
 * visibility and picking (ray casting) are plain math, so they are unit tested.
 */
import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Scene,
  Vector3,
  type Object3D,
  type Raycaster,
} from 'three';
import {
  FLOOR_THICKNESS,
  OVERLAYS,
  center,
  overlayRoutes,
  type AreaLayout,
  type Box,
  type HouseLayout,
  type OverlaySystem,
  type View,
} from './layout';

export type PickResult =
  { kind: 'area'; areaId: number } | { kind: 'item'; areaId: number; itemId: number };

const WALL = 0.12;

const COLORS = {
  floor: 0xc9a77c,
  wall: 0xefe6d8,
  shell: 0xb9c4cc,
  roof: 0x55606b,
  foundation: 0x9a9a96,
  deck: 0x9b6b43,
  driveway: 0x8e9196,
  yard: 0x79a861,
  shedFloor: 0xa9a59c,
  ground: 0x9cc184,
  window: 0x2f4b63,
  item: 0x8a5a3c,
  highlight: 0xf08a4b,
} as const;

const SYSTEM_COLORS: Record<OverlaySystem, number> = {
  electrical: 0xf2c230,
  plumbing: 0x2f7fd8,
  hvac: 0x8c96a3,
};

function slabColor(placed: AreaLayout): number {
  switch (placed.zone) {
    case 'deck':
      return COLORS.deck;
    case 'driveway':
      return COLORS.driveway;
    default:
      return COLORS.yard;
  }
}

function boxMesh(b: Box, material: MeshStandardMaterial): Mesh {
  const size = new Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
  const mesh = new Mesh(new BoxGeometry(size.x, size.y, size.z), material);
  const c = center(b);
  mesh.position.set(c.x, c.y, c.z);
  return mesh;
}

/** Four walls of height `height` standing on y0, inside the box's footprint. */
function walls(b: Box, y0: number, height: number, material: MeshStandardMaterial): Mesh[] {
  const { min, max } = b;
  const y1 = y0 + height;
  return [
    boxMesh(
      { min: { x: min.x, y: y0, z: min.z }, max: { x: max.x, y: y1, z: min.z + WALL } },
      material,
    ),
    boxMesh(
      { min: { x: min.x, y: y0, z: max.z - WALL }, max: { x: max.x, y: y1, z: max.z } },
      material,
    ),
    boxMesh(
      { min: { x: min.x, y: y0, z: min.z }, max: { x: min.x + WALL, y: y1, z: max.z } },
      material,
    ),
    boxMesh(
      { min: { x: max.x - WALL, y: y0, z: min.z }, max: { x: max.x, y: y1, z: max.z } },
      material,
    ),
  ];
}

/** A gable roof whose ridge runs along x, plus the triangular gable ends. */
function gable(b: Box, material: MeshStandardMaterial): Mesh[] {
  const { min, max } = b;
  const midZ = (min.z + max.z) / 2;
  const v = (x: number, y: number, z: number) => [x, y, z];
  const quads = [
    // back slope, front slope
    [v(min.x, min.y, min.z), v(max.x, min.y, min.z), v(max.x, max.y, midZ), v(min.x, max.y, midZ)],
    [v(min.x, max.y, midZ), v(max.x, max.y, midZ), v(max.x, min.y, max.z), v(min.x, min.y, max.z)],
  ];
  const triangles = [
    [v(min.x, min.y, min.z), v(min.x, max.y, midZ), v(min.x, min.y, max.z)],
    [v(max.x, min.y, min.z), v(max.x, min.y, max.z), v(max.x, max.y, midZ)],
  ];
  const positions: number[] = [];
  for (const q of quads) {
    const [a, b2, c, d] = q as [number[], number[], number[], number[]];
    positions.push(...a, ...b2, ...c, ...a, ...c, ...d);
  }
  for (const t of triangles) positions.push(...t.flat());
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return [new Mesh(geometry, material)];
}

/** Dark window panes on the front face of an outside-wall area (decoration only). */
function windows(b: Box): Mesh[] {
  const material = new MeshStandardMaterial({ color: COLORS.window });
  const width = b.max.x - b.min.x;
  const count = Math.max(1, Math.floor(width / 3));
  const height = b.max.y - b.min.y;
  return Array.from({ length: count }, (_, i) => {
    const x = b.min.x + (width * (i + 0.5)) / count;
    return boxMesh(
      {
        min: { x: x - 0.5, y: b.min.y + height * 0.35, z: b.max.z },
        max: { x: x + 0.5, y: b.min.y + height * 0.75, z: b.max.z + 0.04 },
      },
      material,
    );
  });
}

function areaMeshes(
  placed: AreaLayout,
  materials: { main: MeshStandardMaterial; walls: MeshStandardMaterial },
): Mesh[] {
  const { box: b, spec } = placed;
  switch (spec.style) {
    case 'room': {
      const floor = boxMesh(
        { min: b.min, max: { x: b.max.x, y: b.min.y + FLOOR_THICKNESS, z: b.max.z } },
        materials.main,
      );
      return [floor, ...walls(b, b.min.y + FLOOR_THICKNESS, spec.wallHeight, materials.walls)];
    }
    case 'shell':
      return walls(b, b.min.y, spec.wallHeight, materials.main);
    case 'roof':
      return gable(b, materials.main);
    case 'slab':
      return [boxMesh(b, materials.main)];
  }
}

function areaColors(placed: AreaLayout): { main: number; walls: number } {
  switch (placed.spec.style) {
    case 'room':
      return { main: placed.zone === 'shed' ? COLORS.shedFloor : COLORS.floor, walls: COLORS.wall };
    case 'shell':
      return placed.zone === 'foundation'
        ? { main: COLORS.foundation, walls: COLORS.foundation }
        : { main: COLORS.shell, walls: COLORS.shell };
    case 'roof':
      return { main: COLORS.roof, walls: COLORS.roof };
    case 'slab':
      return { main: slabColor(placed), walls: slabColor(placed) };
  }
}

/** True when the object and all of its parents are visible. */
export function isShown(object: Object3D): boolean {
  for (let o: Object3D | null = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

interface AreaEntry {
  placed: AreaLayout;
  group: Group;
  materials: MeshStandardMaterial[];
}

export class HouseScene {
  readonly scene = new Scene();
  private readonly areas = new Map<number, AreaEntry>();
  private readonly itemMaterials = new Map<string, MeshStandardMaterial>();
  private readonly overlays = new Map<OverlaySystem, Group>();
  private readonly pickables: Mesh[] = [];
  private readonly ground: Mesh;
  private view: View = 'main';

  constructor(readonly layout: HouseLayout) {
    this.scene.background = new Color(0xdfe7ee);
    this.scene.add(new HemisphereLight(0xffffff, 0x6b7a5a, 1.6));
    this.scene.add(new AmbientLight(0xffffff, 0.35));
    const sun = new DirectionalLight(0xffffff, 1.6);
    sun.position.set(-8, 20, 14);
    this.scene.add(sun);

    this.ground = new Mesh(
      new PlaneGeometry(80, 80),
      new MeshStandardMaterial({ color: COLORS.ground, side: DoubleSide }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.set(4, -0.02, 4);
    this.scene.add(this.ground);

    for (const placed of layout.areas) this.addArea(placed);
    for (const placedItem of layout.items) {
      const entry = this.areas.get(placedItem.areaId);
      if (!entry) continue;
      const system = placedItem.item.system as OverlaySystem | null;
      const material = new MeshStandardMaterial({
        color: (system && SYSTEM_COLORS[system]) ?? COLORS.item,
        emissive: new Color(0x000000),
      });
      this.itemMaterials.set(`${placedItem.areaId}:${placedItem.item.id}`, material);
      const s = placedItem.size;
      const mesh = new Mesh(new BoxGeometry(s, s, s), material);
      mesh.position.set(placedItem.position.x, placedItem.position.y, placedItem.position.z);
      mesh.userData = {
        pick: { kind: 'item', areaId: placedItem.areaId, itemId: placedItem.item.id },
      };
      entry.group.add(mesh);
      this.pickables.push(mesh);
    }

    for (const overlay of OVERLAYS) {
      const group = new Group();
      group.visible = false;
      const material = new LineBasicMaterial({
        color: SYSTEM_COLORS[overlay.system],
        depthTest: false,
        transparent: true,
        opacity: 0.95,
      });
      for (const points of overlayRoutes(layout, overlay.system)) {
        const line = new Line(
          new BufferGeometry().setFromPoints(points.map((p) => new Vector3(p.x, p.y, p.z))),
          material,
        );
        line.renderOrder = 10;
        group.add(line);
      }
      this.overlays.set(overlay.system, group);
      this.scene.add(group);
    }
    this.setView('main');
  }

  private addArea(placed: AreaLayout): void {
    const colors = areaColors(placed);
    const main = new MeshStandardMaterial({ color: colors.main, emissive: new Color(0x000000) });
    const wallMaterial =
      colors.walls === colors.main
        ? main
        : new MeshStandardMaterial({ color: colors.walls, emissive: new Color(0x000000) });
    if (placed.spec.style === 'roof') main.side = DoubleSide;
    const group = new Group();
    group.userData = { areaId: placed.area.id };
    for (const mesh of areaMeshes(placed, { main, walls: wallMaterial })) {
      mesh.userData = { pick: { kind: 'area', areaId: placed.area.id } };
      group.add(mesh);
      this.pickables.push(mesh);
    }
    if (placed.zone === 'walls') for (const pane of windows(placed.box)) group.add(pane);
    this.areas.set(placed.area.id, {
      placed,
      group,
      materials: main === wallMaterial ? [main] : [main, wallMaterial],
    });
    this.scene.add(group);
  }

  get currentView(): View {
    return this.view;
  }

  setView(view: View): void {
    this.view = view;
    for (const entry of this.areas.values()) {
      entry.group.visible = entry.placed.spec.views.includes(view);
    }
    // The ground would cover the basement.
    this.ground.visible = view !== 'basement';
  }

  isAreaShown(areaId: number): boolean {
    const entry = this.areas.get(areaId);
    return entry ? isShown(entry.group) : false;
  }

  setOverlay(system: OverlaySystem, on: boolean): void {
    const group = this.overlays.get(system);
    if (group) group.visible = on;
  }

  overlayLineCount(system: OverlaySystem): number {
    return this.overlays.get(system)?.children.length ?? 0;
  }

  /** Tints the hovered and selected areas (and the selected item). */
  highlight(hoverAreaId: number | null, selected: PickResult | null): void {
    const accent = new Color(COLORS.highlight);
    for (const [id, entry] of this.areas) {
      const strength =
        selected?.kind === 'area' && selected.areaId === id ? 0.45 : hoverAreaId === id ? 0.25 : 0;
      for (const m of entry.materials) m.emissive.copy(accent).multiplyScalar(strength);
    }
    for (const [key, material] of this.itemMaterials) {
      const on = selected?.kind === 'item' && key === `${selected.areaId}:${selected.itemId}`;
      material.emissive.copy(accent).multiplyScalar(on ? 0.6 : 0);
    }
  }

  /** The nearest visible area or item under the ray, if any. */
  pick(raycaster: Raycaster): PickResult | null {
    this.scene.updateMatrixWorld();
    const hits = raycaster.intersectObjects(this.pickables.filter(isShown), false);
    for (const hit of hits) {
      const pick = (hit.object.userData as { pick?: PickResult }).pick;
      if (pick) return pick;
    }
    return null;
  }

  /** Point to look at and a comfortable viewing distance for an area. */
  focus(areaId: number): { target: Vector3; distance: number } | null {
    const entry = this.areas.get(areaId);
    if (!entry) return null;
    const { box: b, spec } = entry.placed;
    const c = center(b);
    const y = spec.style === 'room' ? b.min.y + FLOOR_THICKNESS : c.y;
    const size = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
    return { target: new Vector3(c.x, y, c.z), distance: Math.max(7, size * 1.6) };
  }
}
