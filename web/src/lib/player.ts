/** Video cards and the player dialog (YouTube's privacy-enhanced embed). */
import { h } from './dom';
import { embedUrl, videoTitle, watchUrl } from './format';
import type { Video } from './types';

function chips(video: Video): HTMLElement {
  const links = [
    ...video.houseAreas.map((a) => ({ name: a.name, kind: 'room', suggested: false })),
    ...video.areaTypes.map((a) => ({ ...a, kind: 'area' })),
    ...video.items.map((i) => ({ ...i, kind: 'item' })),
    ...video.tags.map((t) => ({ ...t, kind: 'tag' })),
  ];
  return h(
    'ul',
    { class: 'chips', 'aria-label': 'Tags and locations' },
    ...links.map((l) =>
      h(
        'li',
        {
          class: `chip ${l.kind}${l.suggested ? ' suggested' : ''}`,
          title: l.suggested ? 'Suggested' : undefined,
        },
        l.name,
      ),
    ),
  );
}

export function openPlayer(video: Video): void {
  const title = videoTitle(video.title, video.metadataStatus);
  const dialog: HTMLDialogElement = h(
    'dialog',
    { class: 'player', 'aria-label': title },
    h(
      'div',
      { class: 'player-frame' },
      h('iframe', {
        src: embedUrl(video.youtubeId),
        title,
        allow: 'encrypted-media; picture-in-picture; fullscreen',
        allowfullscreen: true,
        referrerpolicy: 'strict-origin-when-cross-origin',
      }),
    ),
    h('h2', {}, title),
    video.channelName ? h('p', { class: 'muted' }, video.channelName) : null,
    chips(video),
    h(
      'p',
      { class: 'actions' },
      h(
        'a',
        { href: watchUrl(video.youtubeId), target: '_blank', rel: 'noopener noreferrer' },
        'Open on YouTube',
      ),
      h('button', { type: 'button', on: { click: () => dialog.close() } }, 'Close'),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

export function videoCard(video: Video): HTMLElement {
  const title = videoTitle(video.title, video.metadataStatus);
  return h(
    'article',
    { class: 'card' },
    h(
      'button',
      {
        type: 'button',
        class: 'thumb',
        'aria-label': `Play ${title}`,
        on: { click: () => openPlayer(video) },
      },
      video.thumbnailUrl
        ? h('img', { src: video.thumbnailUrl, alt: '', loading: 'lazy', width: 320, height: 180 })
        : null,
    ),
    h('h3', {}, title),
    video.channelName ? h('p', { class: 'muted' }, video.channelName) : null,
    video.houseId !== null ? h('p', { class: 'badge' }, 'Private to this house') : null,
    chips(video),
  );
}
