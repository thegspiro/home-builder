/** List: sortable, filterable table; editors can re-classify or delete videos. */
import '../styles.css';
import { api, query } from '../lib/api';
import { classificationEditor } from '../lib/classify';
import { byId, h, replaceChildren } from '../lib/dom';
import { areaParams } from '../lib/filters';
import { formatDate, videoTitle } from '../lib/format';
import { attempt, startPage } from '../lib/page';
import { openPlayer } from '../lib/player';
import { canEditVideo, type Session } from '../lib/session';
import type { Catalog, HouseDetail, Video, VideoPage } from '../lib/types';

const PAGE_SIZE = 25;

function names(links: { name: string }[]): string {
  return links.map((l) => l.name).join(', ');
}

async function run(session: Session): Promise<void> {
  const houseId = session.house?.id;
  const [catalog, house] = await Promise.all([
    api<Catalog>('GET', `/api/catalog${query({ houseId })}`),
    houseId ? api<HouseDetail>('GET', `/api/houses/${houseId}`) : Promise.resolve(null),
  ]);

  const form = byId<HTMLFormElement>('list-form');
  const qInput = byId<HTMLInputElement>('q');
  const tagSelect = byId<HTMLSelectElement>('tag');
  const areaSelect = byId<HTMLSelectElement>('area');
  const statusSelect = byId<HTMLSelectElement>('status-filter');
  const sortSelect = byId<HTMLSelectElement>('sort');
  const table = byId<HTMLTableElement>('videos');
  const pageInfo = byId('page-info');
  const prev = byId<HTMLButtonElement>('prev');
  const next = byId<HTMLButtonElement>('next');

  replaceChildren(
    tagSelect,
    h('option', { value: '' }, 'Any tag'),
    ...catalog.tags.map((t) => h('option', { value: String(t.id) }, t.name)),
  );
  replaceChildren(
    areaSelect,
    h('option', { value: '' }, house ? 'Any room' : 'Any area'),
    ...(house
      ? house.areas.map((a) => h('option', { value: `room:${a.id}` }, a.name))
      : catalog.areaTypes.map((a) => h('option', { value: `type:${a.id}` }, a.name))),
  );

  let offset = 0;

  function editDialog(video: Video): void {
    const editor = classificationEditor(video, catalog, house?.areas ?? null);
    const dialog: HTMLDialogElement = h(
      'dialog',
      { 'aria-label': 'Edit classification' },
      h('h2', {}, videoTitle(video.title, video.metadataStatus)),
      editor.element,
      h(
        'p',
        { class: 'actions' },
        h(
          'button',
          {
            type: 'button',
            class: 'primary',
            on: {
              click: () => {
                void attempt(
                  () => api('PUT', `/api/videos/${video.id}/classification`, editor.value()),
                  'Saved.',
                ).then((ok) => {
                  if (ok) {
                    dialog.close();
                    void load();
                  }
                });
              },
            },
          },
          'Save',
        ),
        h('button', { type: 'button', on: { click: () => dialog.close() } }, 'Cancel'),
      ),
    );
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  function row(video: Video): HTMLTableRowElement {
    const editable = canEditVideo(session, video.houseId);
    return h(
      'tr',
      {},
      h(
        'td',
        {},
        video.thumbnailUrl ? h('img', { src: video.thumbnailUrl, alt: '', loading: 'lazy' }) : null,
      ),
      h(
        'td',
        {},
        h(
          'button',
          { type: 'button', class: 'link', on: { click: () => openPlayer(video) } },
          videoTitle(video.title, video.metadataStatus),
        ),
        video.channelName ? h('div', { class: 'muted' }, video.channelName) : null,
        video.houseId !== null ? h('div', { class: 'badge' }, 'Private') : null,
      ),
      h('td', {}, names(video.tags)),
      h('td', {}, names([...video.houseAreas, ...video.areaTypes, ...video.items])),
      h('td', {}, video.reviewStatus === 'inbox' ? 'Inbox' : 'Sorted'),
      h('td', {}, formatDate(video.createdAt)),
      h(
        'td',
        {},
        editable
          ? h(
              'span',
              { class: 'actions' },
              h('button', { type: 'button', on: { click: () => editDialog(video) } }, 'Edit'),
              h(
                'button',
                {
                  type: 'button',
                  class: 'danger',
                  on: {
                    click: () => {
                      const label = videoTitle(video.title, video.metadataStatus);
                      if (!window.confirm(`Delete “${label}” from the library?`)) return;
                      void attempt(() => api('DELETE', `/api/videos/${video.id}`), 'Deleted.').then(
                        (ok) => {
                          if (ok) void load();
                        },
                      );
                    },
                  },
                },
                'Delete',
              ),
            )
          : null,
      ),
    );
  }

  async function load(): Promise<void> {
    const params = {
      houseId,
      q: qInput.value.trim() || undefined,
      tagIds: tagSelect.value || undefined,
      ...areaParams(areaSelect.value),
      status: statusSelect.value,
      sort: sortSelect.value,
      limit: PAGE_SIZE,
      offset,
    };
    const page = await api<VideoPage>('GET', `/api/videos${query(params)}`);
    replaceChildren(
      table,
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['', 'Title', 'Tags', 'Where', 'Status', 'Added', ''].map((label) =>
            h('th', { scope: 'col' }, label),
          ),
        ),
      ),
      h(
        'tbody',
        {},
        ...(page.videos.length
          ? page.videos.map(row)
          : [h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'No videos match.'))]),
      ),
    );
    const first = page.total === 0 ? 0 : offset + 1;
    pageInfo.textContent = `${first}–${offset + page.videos.length} of ${page.total}`;
    prev.disabled = offset === 0;
    next.disabled = offset + page.videos.length >= page.total;
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    offset = 0;
    void load();
  });
  for (const select of [tagSelect, areaSelect, statusSelect, sortSelect]) {
    select.addEventListener('change', () => {
      offset = 0;
      void load();
    });
  }
  prev.addEventListener('click', () => {
    offset = Math.max(0, offset - PAGE_SIZE);
    void load();
  });
  next.addEventListener('click', () => {
    offset += PAGE_SIZE;
    void load();
  });
  await load();
}

void startPage('/list.html', run);
