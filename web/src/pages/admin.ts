/** Admin: houses, playlists, shared imports, keyword rules and shared tags. */
import '../styles.css';
import { api } from '../lib/api';
import { byId, h, replaceChildren } from '../lib/dom';
import { formatDate } from '../lib/format';
import { attempt, notify, startPage } from '../lib/page';
import type { Session } from '../lib/session';
import type { Catalog, HouseSummary, Job, KeywordRule, Playlist, TagKind } from '../lib/types';
import { importForm, jobList } from './imports';

const TAG_KINDS: TagKind[] = ['task', 'skill', 'topic', 'trade', 'tools', 'other'];

async function run(session: Session): Promise<void> {
  const root = byId('admin');
  if (!session.me.isAdmin) {
    replaceChildren(root, h('p', { class: 'notice' }, 'Only administrators can use this page.'));
    return;
  }

  async function render(): Promise<void> {
    const [houses, playlists, jobs, rules, catalog] = await Promise.all([
      api<{ houses: HouseSummary[] }>('GET', '/api/houses'),
      api<{ playlists: Playlist[] }>('GET', '/api/playlists'),
      api<{ jobs: Job[] }>('GET', '/api/jobs'),
      api<{ rules: KeywordRule[] }>('GET', '/api/keyword-rules'),
      api<Catalog>('GET', '/api/catalog'),
    ]);
    const refresh = () => void render();
    replaceChildren(
      root,
      housesSection(houses.houses, refresh),
      playlistsSection(playlists.playlists, refresh),
      h(
        'section',
        { class: 'panel' },
        h('h2', {}, 'Add videos to the shared library'),
        importForm(null, (jobId) => {
          notify(`Import #${jobId} queued.`);
          refresh();
        }),
        h(
          'div',
          { class: 'form-row' },
          h('h2', {}, 'Recent jobs'),
          h('button', { type: 'button', on: { click: refresh } }, 'Refresh'),
        ),
        jobList(jobs.jobs),
      ),
      rulesSection(rules.rules, catalog, refresh),
      tagsSection(catalog, refresh),
    );
  }
  await render();
}

function housesSection(houses: HouseSummary[], refresh: () => void): HTMLElement {
  const name = h('input', {
    type: 'text',
    maxlength: 128,
    placeholder: 'House name',
    'aria-label': 'House name',
    required: true,
  });
  const owner = h('input', {
    type: 'email',
    maxlength: 320,
    placeholder: 'Owner email (default: you)',
    'aria-label': 'Owner email',
  });
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Houses'),
    h(
      'ul',
      {},
      ...houses.map((house) =>
        h(
          'li',
          { class: 'form-row' },
          house.name,
          h(
            'button',
            {
              type: 'button',
              class: 'danger',
              on: {
                click: () => {
                  if (
                    !window.confirm(
                      `Delete “${house.name}”, its rooms and all its private videos and tags? This cannot be undone.`,
                    )
                  )
                    return;
                  void attempt(
                    () => api('DELETE', `/api/houses/${house.id}`),
                    'House deleted.',
                  ).then(refresh);
                },
              },
            },
            'Delete',
          ),
        ),
      ),
    ),
    h(
      'form',
      {
        class: 'form-row',
        on: {
          submit: (event) => {
            event.preventDefault();
            const body = {
              name: name.value,
              ...(owner.value.trim() ? { ownerEmail: owner.value.trim() } : {}),
            };
            void attempt(() => api('POST', '/api/houses', body), 'House created.').then(refresh);
          },
        },
      },
      name,
      owner,
      h('button', { type: 'submit' }, 'Create house'),
    ),
  );
}

function playlistsSection(playlists: Playlist[], refresh: () => void): HTMLElement {
  const url = h('input', {
    type: 'url',
    maxlength: 2048,
    placeholder: 'https://www.youtube.com/playlist?list=…',
    'aria-label': 'Playlist URL',
    required: true,
  });
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Playlists'),
    h(
      'p',
      { class: 'muted' },
      'Public and unlisted playlists sync every night. For a private playlist, export it with Google Takeout and upload the CSV below.',
    ),
    playlists.length
      ? h(
          'table',
          {},
          h(
            'tbody',
            {},
            ...playlists.map((p) =>
              h(
                'tr',
                {},
                h('td', {}, p.title ?? p.youtubePlaylistId),
                h('td', { class: 'muted' }, `Last synced: ${formatDate(p.lastSyncedAt)}`),
                h(
                  'td',
                  {},
                  h(
                    'span',
                    { class: 'actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        on: {
                          click: () =>
                            void attempt(async () => {
                              const r = await api<{ jobId: number; alreadyQueued: boolean }>(
                                'POST',
                                `/api/playlists/${p.id}/sync`,
                              );
                              notify(
                                r.alreadyQueued
                                  ? `A sync is already queued (#${r.jobId}).`
                                  : `Sync #${r.jobId} queued.`,
                              );
                            }).then(refresh),
                        },
                      },
                      'Sync now',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        class: 'danger',
                        on: {
                          click: () => {
                            if (
                              !window.confirm(
                                'Stop syncing this playlist? Videos already imported stay.',
                              )
                            )
                              return;
                            void attempt(
                              () => api('DELETE', `/api/playlists/${p.id}`),
                              'Playlist removed.',
                            ).then(refresh);
                          },
                        },
                      },
                      'Remove',
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No playlists yet.'),
    h(
      'form',
      {
        class: 'form-row',
        on: {
          submit: (event) => {
            event.preventDefault();
            void attempt(
              () => api('POST', '/api/playlists', { url: url.value }),
              'Playlist added; first sync queued.',
            ).then(refresh);
          },
        },
      },
      url,
      h('button', { type: 'submit' }, 'Add playlist'),
    ),
  );
}

function rulesSection(rules: KeywordRule[], catalog: Catalog, refresh: () => void): HTMLElement {
  const phrase = h('input', {
    type: 'text',
    maxlength: 200,
    placeholder: 'Words in the title, e.g. garage door',
    'aria-label': 'Phrase',
    required: true,
  });
  const target = h(
    'select',
    { 'aria-label': 'Suggest', required: true },
    h('option', { value: '' }, 'Suggest…'),
    h(
      'optgroup',
      { label: 'Area types' },
      ...catalog.areaTypes.map((a) => h('option', { value: `areaTypeId:${a.id}` }, a.name)),
    ),
    h(
      'optgroup',
      { label: 'Items' },
      ...catalog.items.map((i) => h('option', { value: `itemId:${i.id}` }, i.name)),
    ),
    h(
      'optgroup',
      { label: 'Tags' },
      ...catalog.tags
        .filter((t) => t.houseId === null)
        .map((t) => h('option', { value: `tagId:${t.id}` }, t.name)),
    ),
  );
  const KIND_LABEL = { tag: 'Tag', areaType: 'Area', item: 'Item' } as const;
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Keyword rules'),
    h(
      'p',
      { class: 'muted' },
      'When a new video’s title contains the words, the inbox suggests the tag, area or item.',
    ),
    rules.length
      ? h(
          'table',
          {},
          h(
            'tbody',
            {},
            ...rules.map((rule) =>
              h(
                'tr',
                {},
                h('td', {}, `“${rule.phrase}”`),
                h('td', {}, `${KIND_LABEL[rule.target.kind]}: ${rule.target.name}`),
                h(
                  'td',
                  {},
                  h(
                    'label',
                    {},
                    h('input', {
                      type: 'checkbox',
                      checked: rule.enabled,
                      on: {
                        change: () =>
                          void attempt(() =>
                            api('PATCH', `/api/keyword-rules/${rule.id}`, {
                              enabled: !rule.enabled,
                            }),
                          ).then(refresh),
                      },
                    }),
                    ' On',
                  ),
                ),
                h(
                  'td',
                  {},
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'danger',
                      on: {
                        click: () =>
                          void attempt(
                            () => api('DELETE', `/api/keyword-rules/${rule.id}`),
                            'Rule deleted.',
                          ).then(refresh),
                      },
                    },
                    'Delete',
                  ),
                ),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No rules yet.'),
    h(
      'form',
      {
        class: 'form-row',
        on: {
          submit: (event) => {
            event.preventDefault();
            const [key, id] = target.value.split(':');
            if (!key || !id) return;
            void attempt(
              () => api('POST', '/api/keyword-rules', { phrase: phrase.value, [key]: Number(id) }),
              'Rule added.',
            ).then(refresh);
          },
        },
      },
      phrase,
      target,
      h('button', { type: 'submit' }, 'Add rule'),
    ),
    h(
      'p',
      { class: 'actions' },
      h(
        'button',
        {
          type: 'button',
          on: {
            click: () =>
              void attempt(async () => {
                const r = await api<{ jobId: number; alreadyQueued: boolean }>(
                  'POST',
                  '/api/keyword-rules/apply',
                );
                notify(
                  r.alreadyQueued
                    ? 'Already queued.'
                    : `Re-applying rules to the inbox (#${r.jobId}).`,
                );
              }).then(refresh),
          },
        },
        'Re-apply rules to the inbox',
      ),
    ),
  );
}

function tagsSection(catalog: Catalog, refresh: () => void): HTMLElement {
  const shared = catalog.tags.filter((t) => t.houseId === null);
  const name = h('input', {
    type: 'text',
    maxlength: 128,
    placeholder: 'New shared tag',
    'aria-label': 'Tag name',
    required: true,
  });
  const kind = h(
    'select',
    { 'aria-label': 'Kind' },
    ...TAG_KINDS.map((k) => h('option', { value: k }, k)),
  );
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Shared tags'),
    h(
      'ul',
      { class: 'chips' },
      ...shared.map((t) =>
        h(
          'li',
          { class: 'chip' },
          `${t.name} `,
          h('span', { class: 'muted' }, t.kind),
          ' ',
          h(
            'button',
            {
              type: 'button',
              class: 'danger',
              'aria-label': `Delete tag ${t.name}`,
              on: {
                click: () => {
                  if (
                    !window.confirm(
                      `Delete the shared tag “${t.name}”? It is removed from every video and rule.`,
                    )
                  )
                    return;
                  void attempt(() => api('DELETE', `/api/tags/${t.id}`), 'Tag deleted.').then(
                    refresh,
                  );
                },
              },
            },
            '×',
          ),
        ),
      ),
    ),
    h(
      'form',
      {
        class: 'form-row',
        on: {
          submit: (event) => {
            event.preventDefault();
            void attempt(
              () => api('POST', '/api/tags', { name: name.value, kind: kind.value }),
              'Tag added.',
            ).then(refresh);
          },
        },
      },
      name,
      kind,
      h('button', { type: 'submit' }, 'Add tag'),
    ),
  );
}

void startPage('/admin.html', run);
