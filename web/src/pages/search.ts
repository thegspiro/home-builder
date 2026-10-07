/** Search: free text, tag chips and an area filter, results as cards. */
import '../styles.css';
import { api, query } from '../lib/api';
import { byId, h, replaceChildren } from '../lib/dom';
import { areaParams } from '../lib/filters';
import { pluralize } from '../lib/format';
import { startPage } from '../lib/page';
import { videoCard } from '../lib/player';
import type { Session } from '../lib/session';
import type { Catalog, HouseDetail, VideoPage } from '../lib/types';

const PAGE_SIZE = 24;

async function run(session: Session): Promise<void> {
  const houseId = session.house?.id;
  const [catalog, house] = await Promise.all([
    api<Catalog>('GET', `/api/catalog${query({ houseId })}`),
    houseId ? api<HouseDetail>('GET', `/api/houses/${houseId}`) : Promise.resolve(null),
  ]);

  const url = new URL(window.location.href);
  const qInput = byId<HTMLInputElement>('q');
  const areaSelect = byId<HTMLSelectElement>('area');
  const results = byId('results');
  const count = byId('count');
  const more = byId<HTMLButtonElement>('more');
  const selectedTags = new Set(
    (url.searchParams.get('tags') ?? '').split(',').filter(Boolean).map(Number),
  );
  qInput.value = url.searchParams.get('q') ?? '';

  replaceChildren(
    areaSelect,
    h('option', { value: '' }, house ? 'Any room' : 'Any area'),
    ...(house
      ? house.areas
          .filter((a) => !a.hidden)
          .map((a) => h('option', { value: `room:${a.id}` }, a.name))
      : catalog.areaTypes.map((a) => h('option', { value: `type:${a.id}` }, a.name))),
  );
  areaSelect.value = url.searchParams.get('area') ?? '';

  const tagFilter = byId('tag-filter');
  replaceChildren(
    tagFilter,
    ...catalog.tags.map((tag) => {
      const button = h(
        'button',
        {
          type: 'button',
          class: 'chip-toggle',
          'aria-pressed': selectedTags.has(tag.id) ? 'true' : 'false',
          on: {
            click: () => {
              if (selectedTags.has(tag.id)) selectedTags.delete(tag.id);
              else selectedTags.add(tag.id);
              button.setAttribute('aria-pressed', selectedTags.has(tag.id) ? 'true' : 'false');
              void search(true);
            },
          },
        },
        tag.name,
      );
      return button;
    }),
  );

  let offset = 0;
  let generation = 0;

  async function search(reset: boolean): Promise<void> {
    if (reset) offset = 0;
    const current = ++generation;
    const params = {
      houseId,
      q: qInput.value.trim() || undefined,
      tagIds: selectedTags.size ? [...selectedTags].join(',') : undefined,
      ...areaParams(areaSelect.value),
      limit: PAGE_SIZE,
      offset,
    };
    const page = await api<VideoPage>('GET', `/api/videos${query(params)}`);
    if (current !== generation) return; // a newer search started meanwhile

    const state = new URL(window.location.href);
    for (const [key, value] of [
      ['q', params.q],
      ['tags', params.tagIds],
      ['area', areaSelect.value || undefined],
    ] as const) {
      if (value) state.searchParams.set(key, value);
      else state.searchParams.delete(key);
    }
    window.history.replaceState(null, '', state);

    if (reset) results.replaceChildren();
    for (const video of page.videos) results.append(videoCard(video));
    offset += page.videos.length;
    count.textContent =
      page.total === 0 ? 'No videos match.' : `${pluralize(page.total, 'video')} found`;
    more.hidden = offset >= page.total;
  }

  let debounce: number | undefined;
  qInput.addEventListener('input', () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => void search(true), 300);
  });
  areaSelect.addEventListener('change', () => void search(true));
  byId('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    void search(true);
  });
  more.addEventListener('click', () => void search(false));
  await search(true);
}

void startPage('/', run);
