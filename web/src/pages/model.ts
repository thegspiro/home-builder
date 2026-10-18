/**
 * 3D house: a cutaway model of the selected house. Click a room, an item or a system
 * to see its videos. The area list beside the model does the same with a keyboard, and
 * is all there is when the browser has no WebGL.
 */
import '../styles.css';
import { api, query } from '../lib/api';
import { byId, h, replaceChildren } from '../lib/dom';
import { pluralize } from '../lib/format';
import { errorMessage, notify, startPage } from '../lib/page';
import { videoCard } from '../lib/player';
import { canEditHouse, type Session } from '../lib/session';
import type { Catalog, HouseDetail, HouseItem, VideoPage } from '../lib/types';
import {
  OVERLAYS,
  VIEWS,
  layoutHouse,
  viewFor,
  type AreaLayout,
  type HouseLayout,
  type OverlaySystem,
  type View,
} from '../lib/house3d/layout';
import {
  formatSelection,
  parseSelection,
  parseView,
  sameSelection,
  type Selection,
} from '../lib/house3d/selection';
import type { PickResult } from '../lib/house3d/scene';
import { ModelView, webglAvailable } from '../lib/house3d/view';

const PAGE_SIZE = 12;

const GROUP_LABELS = { inside: 'Inside', outside: 'Outside', workshop: 'Workshop' } as const;

type SystemType = Catalog['areaTypes'][number];
type Content = (HTMLElement | null)[];

function startView(container: HTMLElement, layout: HouseLayout, onPick: (p: PickResult) => void) {
  if (!webglAvailable()) return null;
  try {
    return new ModelView({ container, layout, onPick });
  } catch {
    return null;
  }
}

async function run(session: Session): Promise<void> {
  const viewport = byId('viewport');
  const panel = byId('panel');
  const menu = byId('area-menu');
  const toolbar = byId('model-toolbar');
  const selected = session.house;
  if (!selected) {
    viewport.hidden = true;
    replaceChildren(
      panel,
      h('p', { class: 'notice' }, 'Choose a house from the menu at the top to see it in 3D.'),
    );
    return;
  }

  const [house, catalog] = await Promise.all([
    api<HouseDetail>('GET', `/api/houses/${selected.id}`),
    api<Catalog>('GET', `/api/catalog${query({ houseId: selected.id })}`),
  ]);
  byId('house-title').textContent = house.name;

  const layout = layoutHouse(house);
  const areaById = new Map(layout.areas.map((placed) => [placed.area.id, placed]));
  const itemById = new Map(house.items.map((item) => [item.id, item]));
  const systems = catalog.areaTypes.filter((type) => type.category === 'system');
  const wholeHouse = house.items.filter((item) => item.wholeHouse && !item.hidden);
  const overlayOn = new Set<OverlaySystem>();

  let selection: Selection | null = null;
  const model = startView(viewport, layout, (pick) =>
    select(
      pick.kind === 'area'
        ? { kind: 'area', areaId: pick.areaId }
        : { kind: 'item', itemId: pick.itemId, areaId: pick.areaId },
    ),
  );
  viewport.dataset['mode'] = model ? '3d' : 'menu';
  if (!model) {
    replaceChildren(
      viewport,
      h(
        'p',
        { class: 'notice' },
        'The 3D view isn’t available in this browser. Use the list of areas instead.',
      ),
    );
  }

  // --- Toolbar: levels and system overlays --------------------------------------------

  const viewButtons = new Map<View, HTMLButtonElement>();
  const overlayBoxes = new Map<OverlaySystem, HTMLInputElement>();

  function showView(view: View): void {
    if (!model) return;
    model.setView(view);
    for (const [id, button] of viewButtons) {
      button.setAttribute('aria-pressed', id === view ? 'true' : 'false');
    }
    writeUrl();
  }

  function setOverlay(system: OverlaySystem, on: boolean): void {
    if (on) overlayOn.add(system);
    else overlayOn.delete(system);
    model?.setOverlay(system, on);
    const box = overlayBoxes.get(system);
    if (box) box.checked = on;
  }

  if (model) {
    const levels = h(
      'div',
      { class: 'segmented', role: 'group', 'aria-label': 'Level' },
      ...VIEWS.map((v) => {
        const button = h(
          'button',
          { type: 'button', 'aria-pressed': 'false', on: { click: () => showView(v.id) } },
          v.label,
        );
        viewButtons.set(v.id, button);
        return button;
      }),
    );
    const overlays = h(
      'fieldset',
      { class: 'overlays' },
      h('legend', {}, 'Show systems'),
      ...OVERLAYS.filter((o) => systems.some((s) => s.slug === o.system)).map((o) => {
        const box = h('input', {
          type: 'checkbox',
          on: { change: () => setOverlay(o.system, box.checked) },
        });
        overlayBoxes.set(o.system, box);
        return h('label', { class: `overlay-toggle ${o.system}` }, box, ` ${o.label}`);
      }),
    );
    replaceChildren(
      toolbar,
      levels,
      overlays,
      h('button', { type: 'button', on: { click: () => model.resetCamera() } }, 'Reset camera'),
    );
  }

  // --- Area menu ------------------------------------------------------------------------

  const menuButtons = new Map<string, HTMLButtonElement>();

  function menuButton(label: string, target: Selection): HTMLLIElement {
    const button = h(
      'button',
      { type: 'button', class: 'menu-item', on: { click: () => select(target) } },
      label,
    );
    menuButtons.set(formatSelection(target), button);
    return h('li', {}, button);
  }

  function menuGroup(title: string, entries: HTMLLIElement[]): HTMLElement | null {
    if (entries.length === 0) return null;
    return h('div', { class: 'menu-group' }, h('h2', {}, title), h('ul', {}, ...entries));
  }

  replaceChildren(
    menu,
    ...(Object.keys(GROUP_LABELS) as (keyof typeof GROUP_LABELS)[]).map((group) =>
      menuGroup(
        GROUP_LABELS[group],
        layout.areas
          .filter((placed) => placed.spec.group === group)
          .map((placed) => menuButton(placed.area.name, { kind: 'area', areaId: placed.area.id })),
      ),
    ),
    menuGroup(
      'Systems',
      systems.map((type) => menuButton(type.name, { kind: 'system', areaTypeId: type.id })),
    ),
    menuGroup(
      'Throughout the house',
      wholeHouse.map((item) =>
        menuButton(item.name, { kind: 'item', itemId: item.id, areaId: null }),
      ),
    ),
    canEditHouse(session)
      ? h(
          'p',
          { class: 'muted' },
          h('a', { href: `/house.html?house=${house.id}` }, 'Change rooms and where things are'),
        )
      : null,
  );

  // --- Panel ----------------------------------------------------------------------------

  let generation = 0;

  function videoFilter(target: Selection): Record<string, number> {
    switch (target.kind) {
      case 'area':
        return { houseAreaId: target.areaId };
      case 'item':
        return { itemId: target.itemId };
      case 'system':
        return { areaTypeId: target.areaTypeId };
    }
  }

  function itemButton(item: HouseItem, areaId: number): HTMLLIElement {
    return h(
      'li',
      {},
      h(
        'button',
        {
          type: 'button',
          class: 'chip-toggle',
          on: { click: () => select({ kind: 'item', itemId: item.id, areaId }) },
        },
        item.name,
      ),
    );
  }

  function areaDetails(placed: AreaLayout): Content {
    const items = house.items.filter(
      (item) => !item.hidden && !item.wholeHouse && item.areaIds.includes(placed.area.id),
    );
    return [
      h('h2', {}, placed.area.name),
      items.length
        ? h(
            'div',
            {},
            h('h3', { class: 'small' }, 'Here'),
            h('ul', { class: 'chips' }, ...items.map((item) => itemButton(item, placed.area.id))),
          )
        : null,
      h(
        'p',
        { class: 'muted' },
        h('a', { href: `/?house=${house.id}&area=room:${placed.area.id}` }, 'Open in Search'),
      ),
    ];
  }

  function itemDetails(item: HouseItem, areaId: number | null): Content {
    const rooms = item.areaIds
      .map((id) => areaById.get(id))
      .filter((placed): placed is AreaLayout => placed !== undefined);
    return [
      h('h2', {}, item.name),
      item.wholeHouse
        ? h('p', { class: 'muted' }, 'Found throughout the house.')
        : h(
            'p',
            { class: 'muted' },
            rooms.length ? 'In ' : 'Not placed in a room.',
            ...rooms.flatMap((placed, i) => [
              i > 0 ? ', ' : null,
              h(
                'button',
                {
                  type: 'button',
                  class: 'link',
                  'aria-current': placed.area.id === areaId ? 'true' : undefined,
                  on: { click: () => select({ kind: 'area', areaId: placed.area.id }) },
                },
                placed.area.name,
              ),
            ]),
          ),
    ];
  }

  function systemDetails(type: SystemType): Content {
    const overlay = OVERLAYS.find((o) => o.system === type.slug);
    let toggle: HTMLElement | null = null;
    if (overlay && model) {
      const box = h('input', {
        type: 'checkbox',
        checked: overlayOn.has(overlay.system),
        on: { change: () => setOverlay(overlay.system, box.checked) },
      });
      toggle = h(
        'label',
        { class: 'overlay-toggle' },
        box,
        ` Show ${overlay.label.toLowerCase()} on the model`,
      );
    }
    return [h('h2', {}, type.name), toggle];
  }

  function details(target: Selection): Content | null {
    switch (target.kind) {
      case 'area': {
        const placed = areaById.get(target.areaId);
        return placed ? areaDetails(placed) : null;
      }
      case 'item': {
        const item = itemById.get(target.itemId);
        if (!item || item.hidden) return null;
        if (target.areaId !== null && !item.areaIds.includes(target.areaId)) return null;
        return itemDetails(item, target.areaId);
      }
      case 'system': {
        const type = systems.find((s) => s.id === target.areaTypeId);
        return type ? systemDetails(type) : null;
      }
    }
  }

  async function loadVideos(
    target: Selection,
    list: HTMLElement,
    count: HTMLElement,
    more: HTMLButtonElement,
    offset: number,
  ): Promise<void> {
    const current = generation;
    const page = await api<VideoPage>(
      'GET',
      `/api/videos${query({ houseId: house.id, ...videoFilter(target), limit: PAGE_SIZE, offset })}`,
    );
    if (current !== generation) return; // another selection was made meanwhile
    for (const video of page.videos) list.append(videoCard(video));
    const shown = offset + page.videos.length;
    count.textContent = page.total === 0 ? 'No videos here yet.' : pluralize(page.total, 'video');
    more.hidden = shown >= page.total;
    more.onclick = () => void loadVideos(target, list, count, more, shown).catch(reportError);
  }

  function reportError(error: unknown): void {
    notify(errorMessage(error), 'error');
  }

  function renderPanel(): void {
    generation += 1;
    const content = selection ? details(selection) : null;
    if (!selection || !content) {
      replaceChildren(
        panel,
        h('h2', {}, 'Pick a place'),
        h(
          'p',
          { class: 'muted' },
          model
            ? 'Click a room, an item or the outside of the house, or choose from the list.'
            : 'Choose a room or system from the list.',
        ),
      );
      return;
    }
    const count = h('p', { class: 'muted' }, 'Loading videos…');
    const list = h('div', { class: 'grid compact' });
    const more = h('button', { type: 'button', hidden: true }, 'Show more');
    replaceChildren(panel, ...content, count, list, h('div', { class: 'pager' }, more));
    void loadVideos(selection, list, count, more, 0).catch(reportError);
  }

  function writeUrl(): void {
    const url = new URL(window.location.href);
    if (selection) url.searchParams.set('select', formatSelection(selection));
    else url.searchParams.delete('select');
    if (model) url.searchParams.set('view', model.view);
    window.history.replaceState(null, '', url);
  }

  function select(target: Selection | null): void {
    if (target && details(target) === null) target = null; // stale link
    if (sameSelection(target, selection) && target !== null) return;
    selection = target;
    for (const [key, button] of menuButtons) {
      const on = selection !== null && key === formatSelection(selection);
      button.setAttribute('aria-current', on ? 'true' : 'false');
    }
    if (model) {
      const areaId =
        selection?.kind === 'area'
          ? selection.areaId
          : selection?.kind === 'item'
            ? selection.areaId
            : null;
      const placed = areaId !== null ? areaById.get(areaId) : undefined;
      if (placed) showView(viewFor(placed, model.view));
      if (selection?.kind === 'system') {
        const { areaTypeId } = selection;
        const slug = systems.find((s) => s.id === areaTypeId)?.slug;
        const overlay = OVERLAYS.find((o) => o.system === slug);
        if (overlay) setOverlay(overlay.system, true);
      }
      model.select(
        placed && selection?.kind === 'area'
          ? { kind: 'area', areaId: placed.area.id }
          : placed && selection?.kind === 'item'
            ? { kind: 'item', areaId: placed.area.id, itemId: selection.itemId }
            : null,
      );
    }
    renderPanel();
    writeUrl();
  }

  const url = new URL(window.location.href);
  showView(parseView(url.searchParams.get('view')) ?? 'main');
  select(parseSelection(url.searchParams.get('select')));
}

void startPage('/model.html', run);
