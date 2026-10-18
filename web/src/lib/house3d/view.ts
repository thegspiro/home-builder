/**
 * The interactive 3D view: WebGL renderer, orbit camera, area labels, hover and click.
 * It renders only when something changes, so an idle page costs no GPU time.
 */
import { PerspectiveCamera, Raycaster, Vector2, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { h } from '../dom';
import { HouseScene, type PickResult } from './scene';
import {
  CAMERA_OFFSET,
  CAMERA_TARGET,
  type HouseLayout,
  type OverlaySystem,
  type View,
} from './layout';

export interface ModelViewOptions {
  container: HTMLElement;
  layout: HouseLayout;
  /** Called when an area or item is clicked. */
  onPick: (pick: PickResult) => void;
}

const DEFAULT_TARGET = new Vector3(CAMERA_TARGET.x, CAMERA_TARGET.y, CAMERA_TARGET.z);
const DEFAULT_OFFSET = new Vector3(CAMERA_OFFSET.x, CAMERA_OFFSET.y, CAMERA_OFFSET.z);
/** A press that moves more than this many pixels is a drag (orbit), not a click. */
const CLICK_SLOP = 5;
const FLY_MS = 600;

/** True when the browser can create a WebGL context at all. */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export class ModelView {
  readonly house: HouseScene;
  private readonly renderer: WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly camera = new PerspectiveCamera(45, 1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly raycaster = new Raycaster();
  private readonly tip: HTMLElement;
  private readonly labelObjects = new Map<number, CSS2DObject>();
  private readonly names = new Map<string, string>();
  private hoverAreaId: number | null = null;
  private selected: PickResult | null = null;
  private frame = 0;
  private flight = 0;

  /** Throws if WebGL can't be started; the caller falls back to the area menu. */
  constructor(private readonly options: ModelViewOptions) {
    const { container, layout } = options;
    this.house = new HouseScene(layout);
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = this.renderer.domElement;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.classList.add('model-canvas');

    this.labels.domElement.classList.add('model-labels');
    this.tip = h('div', { class: 'model-tip', hidden: true });
    container.append(canvas, this.labels.domElement, this.tip);

    for (const placed of layout.areas) {
      const label = new CSS2DObject(h('span', { class: 'model-label' }, placed.area.name));
      label.position.set(placed.label.x, placed.label.y, placed.label.z);
      this.house.scene.add(label);
      this.labelObjects.set(placed.area.id, label);
      this.names.set(`area:${placed.area.id}`, placed.area.name);
    }
    for (const placed of layout.items) {
      const room = layout.areas.find((a) => a.area.id === placed.areaId)?.area.name ?? '';
      this.names.set(`item:${placed.item.id}`, `${placed.item.name} · ${room}`);
    }

    this.camera.position.copy(DEFAULT_TARGET).add(DEFAULT_OFFSET);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(DEFAULT_TARGET);
    this.controls.minDistance = 3;
    this.controls.maxDistance = 70;
    // Keep the camera above the ground.
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.addEventListener('change', () => this.requestRender());
    this.controls.addEventListener('start', () => this.cancelFlight());
    this.controls.update();

    this.bindPointer(canvas);
    new ResizeObserver(() => this.resize()).observe(container);
    canvas.addEventListener('webglcontextrestored', () => this.requestRender());
    this.resize();
    this.syncLabels();
  }

  private bindPointer(canvas: HTMLCanvasElement): void {
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (event) => {
      down = { x: event.clientX, y: event.clientY };
    });
    canvas.addEventListener('pointerup', (event) => {
      if (!down) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down = null;
      if (moved > CLICK_SLOP) return;
      const pick = this.pickAt(event.clientX, event.clientY);
      if (pick) this.options.onPick(pick);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (down) return; // orbiting
      const pick = this.pickAt(event.clientX, event.clientY);
      const hoverAreaId = pick?.areaId ?? null;
      const name = pick
        ? this.names.get(pick.kind === 'item' ? `item:${pick.itemId}` : `area:${pick.areaId}`)
        : undefined;
      canvas.style.cursor = pick ? 'pointer' : '';
      if (name) {
        const rect = canvas.getBoundingClientRect();
        this.tip.textContent = name;
        this.tip.style.left = `${event.clientX - rect.left + 14}px`;
        this.tip.style.top = `${event.clientY - rect.top + 14}px`;
        this.tip.hidden = false;
      } else {
        this.tip.hidden = true;
      }
      if (hoverAreaId !== this.hoverAreaId) {
        this.hoverAreaId = hoverAreaId;
        this.house.highlight(this.hoverAreaId, this.selected);
        this.requestRender();
      }
    });
    canvas.addEventListener('pointerleave', () => {
      this.tip.hidden = true;
      if (this.hoverAreaId !== null) {
        this.hoverAreaId = null;
        this.house.highlight(null, this.selected);
        this.requestRender();
      }
    });
  }

  private pickAt(clientX: number, clientY: number): PickResult | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.house.pick(this.raycaster);
  }

  private resize(): void {
    const { clientWidth: width, clientHeight: height } = this.options.container;
    if (width === 0 || height === 0) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.labels.setSize(width, height);
    this.requestRender();
  }

  private syncLabels(): void {
    for (const [areaId, label] of this.labelObjects) {
      label.visible = this.house.isAreaShown(areaId);
    }
  }

  requestRender(): void {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.renderer.render(this.house.scene, this.camera);
      this.labels.render(this.house.scene, this.camera);
      this.options.container.dataset['rendered'] = 'true';
    });
  }

  get view(): View {
    return this.house.currentView;
  }

  setView(view: View): void {
    if (view === this.house.currentView) return;
    this.house.setView(view);
    this.syncLabels();
    this.requestRender();
  }

  setOverlay(system: OverlaySystem, on: boolean): void {
    this.house.setOverlay(system, on);
    this.requestRender();
  }

  /** Highlights the selection and flies the camera to its area. */
  select(selection: PickResult | null): void {
    this.selected = selection;
    this.house.highlight(this.hoverAreaId, selection);
    if (selection) this.flyTo(selection.areaId);
    this.requestRender();
  }

  private cancelFlight(): void {
    if (this.flight) window.cancelAnimationFrame(this.flight);
    this.flight = 0;
  }

  private flyTo(areaId: number): void {
    const focus = this.house.focus(areaId);
    if (!focus) return;
    this.cancelFlight();
    // Keep the current viewing direction; just move closer to the area.
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    const endTarget = focus.target;
    const endPosition = focus.target.clone().add(direction.multiplyScalar(focus.distance));
    const startTarget = this.controls.target.clone();
    const startPosition = this.camera.position.clone();
    const apply = (t: number) => {
      this.controls.target.lerpVectors(startTarget, endTarget, t);
      this.camera.position.lerpVectors(startPosition, endPosition, t);
      this.controls.update();
    };
    if (prefersReducedMotion()) {
      apply(1);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / FLY_MS);
      apply(1 - Math.pow(1 - t, 3)); // ease out
      this.flight = t < 1 ? window.requestAnimationFrame(step) : 0;
    };
    this.flight = window.requestAnimationFrame(step);
  }

  /** Back to the starting viewpoint. */
  resetCamera(): void {
    this.cancelFlight();
    this.controls.target.copy(DEFAULT_TARGET);
    this.camera.position.copy(DEFAULT_TARGET).add(DEFAULT_OFFSET);
    this.controls.update();
  }
}
