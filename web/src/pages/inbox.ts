/**
 * Inbox: videos waiting for review, with keyword-rule suggestions pre-checked.
 * Admins review the shared library ("Shared library only" selected); house owners and
 * editors review their house's private videos.
 */
import '../styles.css';
import { api, query } from '../lib/api';
import { classificationEditor } from '../lib/classify';
import { byId, h, replaceChildren } from '../lib/dom';
import { pluralize, videoTitle } from '../lib/format';
import { attempt, startPage } from '../lib/page';
import { openPlayer } from '../lib/player';
import { canEditHouse, type Session } from '../lib/session';
import type { Catalog, HouseDetail, Video, VideoPage } from '../lib/types';

const PAGE_SIZE = 20;

async function run(session: Session): Promise<void> {
  const container = byId('inbox');
  const title = byId('inbox-title');
  const count = byId('count');
  const more = byId<HTMLButtonElement>('more');

  const houseId = session.house && canEditHouse(session) ? session.house.id : undefined;
  if (houseId === undefined && !session.me.isAdmin) {
    replaceChildren(
      container,
      h('p', { class: 'notice' }, 'Choose a house you can edit to review its new videos.'),
    );
    return;
  }
  title.textContent =
    session.house && houseId ? `Inbox · ${session.house.name}` : 'Inbox · Shared library';

  const [catalog, house] = await Promise.all([
    api<Catalog>('GET', `/api/catalog${query({ houseId })}`),
    houseId ? api<HouseDetail>('GET', `/api/houses/${houseId}`) : Promise.resolve(null),
  ]);

  let offset = 0;
  let total = 0;

  function updateCount(): void {
    count.textContent =
      total === 0 ? 'Nothing to review.' : `${pluralize(total, 'video')} to review`;
  }

  function item(video: Video): HTMLElement {
    const editor = classificationEditor(video, catalog, house?.areas ?? null);
    const label = videoTitle(video.title, video.metadataStatus);
    const done = () => {
      element.remove();
      total -= 1;
      offset -= 1;
      updateCount();
    };
    const save = (sorted: boolean) =>
      attempt(
        () => api('PUT', `/api/videos/${video.id}/classification`, { ...editor.value(), sorted }),
        sorted ? `Confirmed “${label}”.` : 'Saved.',
      ).then((ok) => {
        if (ok && sorted) done();
      });
    const element = h(
      'section',
      { class: 'panel inbox-item', 'aria-label': label },
      h(
        'div',
        {},
        h(
          'button',
          {
            type: 'button',
            class: 'thumb',
            'aria-label': `Play ${label}`,
            on: { click: () => openPlayer(video) },
          },
          video.thumbnailUrl
            ? h('img', { src: video.thumbnailUrl, alt: '', loading: 'lazy' })
            : null,
        ),
        h('h2', {}, label),
        video.channelName ? h('p', { class: 'muted' }, video.channelName) : null,
        h(
          'p',
          { class: 'actions' },
          h(
            'button',
            { type: 'button', class: 'primary', on: { click: () => void save(true) } },
            'Confirm',
          ),
          h('button', { type: 'button', on: { click: () => void save(false) } }, 'Save for later'),
          h(
            'button',
            {
              type: 'button',
              class: 'danger',
              on: {
                click: () => {
                  if (!window.confirm(`Delete “${label}”? It is not about the house.`)) return;
                  void attempt(() => api('DELETE', `/api/videos/${video.id}`), 'Deleted.').then(
                    (ok) => {
                      if (ok) done();
                    },
                  );
                },
              },
            },
            'Delete',
          ),
        ),
      ),
      editor.element,
    );
    return element;
  }

  async function load(): Promise<void> {
    const page = await api<VideoPage>(
      'GET',
      `/api/inbox${query({ houseId, limit: PAGE_SIZE, offset })}`,
    );
    total = page.total;
    for (const video of page.videos) container.append(item(video));
    offset += page.videos.length;
    updateCount();
    more.hidden = offset >= total;
  }

  more.addEventListener('click', () => void load());
  await load();
}

void startPage('/inbox.html', run);
