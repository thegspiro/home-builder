/**
 * Classification editor: checkbox lists of tags, area types, items and (for a house's
 * private videos) house areas, each with a filter box. Used by the List and Inbox pages.
 */
import { h } from './dom';
import type { Catalog, HouseArea, Video } from './types';

export interface Classification {
  tagIds: number[];
  areaTypeIds: number[];
  itemIds: number[];
  houseAreaIds?: number[];
}

interface Option {
  id: number;
  name: string;
  hint?: string | undefined;
}

function checkGroup(
  legend: string,
  name: string,
  options: Option[],
  checked: Set<number>,
  suggested: Set<number>,
): { element: HTMLElement; values: () => number[] } {
  const boxes: HTMLInputElement[] = [];
  const rows = options.map((option) => {
    const box = h('input', {
      type: 'checkbox',
      name,
      value: String(option.id),
      checked: checked.has(option.id),
    });
    boxes.push(box);
    return h(
      'label',
      {
        class: `check${suggested.has(option.id) ? ' suggested' : ''}`,
        'data-name': option.name.toLowerCase(),
      },
      box,
      ' ',
      option.name,
      option.hint ? h('span', { class: 'muted' }, ` · ${option.hint}`) : null,
      suggested.has(option.id) ? h('span', { class: 'muted' }, ' (suggested)') : null,
    );
  });
  const list = h('div', { class: 'check-list' }, ...rows);
  const filter = h('input', {
    type: 'search',
    placeholder: `Filter ${legend.toLowerCase()}…`,
    'aria-label': `Filter ${legend}`,
    on: {
      input: () => {
        const term = filter.value.trim().toLowerCase();
        for (const row of rows) {
          row.hidden =
            term !== '' &&
            !(row.dataset['name'] ?? '').includes(term) &&
            !(row.querySelector('input')?.checked ?? false);
        }
      },
    },
  });
  return {
    element: h('fieldset', { class: 'check-group' }, h('legend', {}, legend), filter, list),
    values: () => boxes.filter((b) => b.checked).map((b) => Number(b.value)),
  };
}

const ids = (links: { id: number }[]) => new Set(links.map((l) => l.id));
const suggestedIds = (links: { id: number; suggested: boolean }[]) =>
  new Set(links.filter((l) => l.suggested).map((l) => l.id));

/** Builds the editor, pre-checked with the video's current links (confirmed and suggested). */
export function classificationEditor(
  video: Video,
  catalog: Catalog,
  houseAreas: HouseArea[] | null,
): { element: HTMLElement; value: () => Classification } {
  const tagOptions = catalog.tags
    .filter((t) => t.houseId === null || t.houseId === video.houseId)
    .map((t) => ({ id: t.id, name: t.name, hint: t.houseId === null ? t.kind : 'house tag' }));
  const tags = checkGroup('Tags', 'tag', tagOptions, ids(video.tags), suggestedIds(video.tags));
  const areas = checkGroup(
    'Area types',
    'area',
    catalog.areaTypes.map((a) => ({ id: a.id, name: a.name, hint: a.category })),
    ids(video.areaTypes),
    suggestedIds(video.areaTypes),
  );
  const items = checkGroup(
    'Items',
    'item',
    catalog.items.map((i) => ({ id: i.id, name: i.name, hint: i.system ?? undefined })),
    ids(video.items),
    suggestedIds(video.items),
  );
  const rooms =
    video.houseId !== null && houseAreas
      ? checkGroup(
          'Rooms in this house',
          'room',
          houseAreas.map((a) => ({ id: a.id, name: a.name })),
          ids(video.houseAreas),
          new Set(),
        )
      : null;
  return {
    element: h(
      'div',
      { class: 'classify' },
      tags.element,
      areas.element,
      items.element,
      rooms?.element,
    ),
    value: () => ({
      tagIds: tags.values(),
      areaTypeIds: areas.values(),
      itemIds: items.values(),
      ...(rooms ? { houseAreaIds: rooms.values() } : {}),
    }),
  };
}
