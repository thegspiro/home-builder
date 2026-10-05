/**
 * House settings: name, rooms, where items are, members, house tags and private videos.
 * Viewers see everything read-only; owners and editors can change the layout; owners
 * manage members (docs/PLAN.md section 6).
 */
import '../styles.css';
import { api, query } from '../lib/api';
import { byId, h, replaceChildren } from '../lib/dom';
import { attempt, notify, startPage } from '../lib/page';
import { canEditHouse, type Session } from '../lib/session';
import {
  HOUSE_ZONES,
  type Catalog,
  type HouseDetail,
  type HouseRole,
  type Job,
} from '../lib/types';
import { importForm, jobList } from './imports';

async function run(session: Session): Promise<void> {
  const root = byId('house');
  const house = session.house;
  if (!house) {
    replaceChildren(root, h('p', { class: 'notice' }, 'Choose a house from the menu at the top.'));
    return;
  }
  const isOwner = session.me.isAdmin || house.role === 'owner';
  const canEdit = canEditHouse(session);

  async function render(): Promise<void> {
    const [detail, catalog, members] = await Promise.all([
      api<HouseDetail>('GET', `/api/houses/${house!.id}`),
      api<Catalog>('GET', `/api/catalog${query({ houseId: house!.id })}`),
      api<{ members: { email: string; role: HouseRole }[] }>(
        'GET',
        `/api/houses/${house!.id}/members`,
      ),
    ]);
    byId('house-title').textContent = detail.name;
    const refresh = () => void render();
    replaceChildren(
      root,
      isOwner ? nameSection(detail, refresh) : null,
      roomsSection(detail, catalog, canEdit, refresh),
      itemsSection(detail, canEdit, refresh),
      membersSection(detail.id, members.members, isOwner, refresh),
      tagsSection(detail.id, catalog, canEdit, refresh),
      canEdit ? await privateVideosSection(detail.id) : null,
    );
  }
  await render();
}

function nameSection(house: HouseDetail, refresh: () => void): HTMLElement {
  const input = h('input', {
    type: 'text',
    value: house.name,
    maxlength: 128,
    'aria-label': 'House name',
    required: true,
  });
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Name'),
    h(
      'form',
      {
        class: 'form-row',
        on: {
          submit: (event) => {
            event.preventDefault();
            void attempt(
              () => api('PATCH', `/api/houses/${house.id}`, { name: input.value }),
              'Renamed.',
            ).then(refresh);
          },
        },
      },
      input,
      h('button', { type: 'submit' }, 'Rename'),
    ),
  );
}

function roomsSection(
  house: HouseDetail,
  catalog: Catalog,
  canEdit: boolean,
  refresh: () => void,
): HTMLElement {
  const roomTypes = catalog.areaTypes.filter((a) => a.category !== 'system');
  const rows = house.areas.map((area) => {
    const name = h('input', {
      type: 'text',
      value: area.name,
      maxlength: 128,
      'aria-label': `Name of ${area.name}`,
      disabled: !canEdit,
    });
    return h(
      'tr',
      {},
      h('td', {}, name),
      h('td', {}, area.zone),
      h('td', {}, area.hidden ? 'Hidden' : 'Shown'),
      h(
        'td',
        {},
        canEdit
          ? h(
              'span',
              { class: 'actions' },
              h(
                'button',
                {
                  type: 'button',
                  on: {
                    click: () =>
                      void attempt(
                        () =>
                          api('PATCH', `/api/houses/${house.id}/areas/${area.id}`, {
                            name: name.value,
                          }),
                        'Saved.',
                      ).then(refresh),
                  },
                },
                'Save',
              ),
              h(
                'button',
                {
                  type: 'button',
                  on: {
                    click: () =>
                      void attempt(() =>
                        api('PATCH', `/api/houses/${house.id}/areas/${area.id}`, {
                          hidden: !area.hidden,
                        }),
                      ).then(refresh),
                  },
                },
                area.hidden ? 'Show' : 'Hide',
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
                          `Delete “${area.name}”? Items placed there will be un-placed.`,
                        )
                      )
                        return;
                      void attempt(
                        () => api('DELETE', `/api/houses/${house.id}/areas/${area.id}`),
                        'Deleted.',
                      ).then(refresh);
                    },
                  },
                },
                'Delete',
              ),
            )
          : null,
      ),
    );
  });

  const kind = h(
    'select',
    { 'aria-label': 'Kind of room' },
    h('option', { value: '' }, 'Custom room…'),
    ...roomTypes.map((t) => h('option', { value: String(t.id) }, `Another ${t.name}`)),
  );
  const zone = h(
    'select',
    { 'aria-label': 'Where in the 3D house' },
    ...HOUSE_ZONES.map((z) => h('option', { value: z }, z)),
  );
  const newName = h('input', {
    type: 'text',
    maxlength: 128,
    placeholder: 'Name, e.g. Mudroom',
    'aria-label': 'New room name',
  });
  kind.addEventListener('change', () => {
    zone.disabled = kind.value !== '';
  });

  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Rooms'),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...['Name', 'Zone', 'Visibility', ''].map((t) => h('th', { scope: 'col' }, t)),
          ),
        ),
        h('tbody', {}, ...rows),
      ),
    ),
    canEdit
      ? h(
          'form',
          {
            class: 'form-row',
            on: {
              submit: (event) => {
                event.preventDefault();
                const body = kind.value
                  ? {
                      areaTypeId: Number(kind.value),
                      ...(newName.value.trim() ? { name: newName.value } : {}),
                    }
                  : { name: newName.value, zone: zone.value };
                void attempt(
                  () => api('POST', `/api/houses/${house.id}/areas`, body),
                  'Room added.',
                ).then(refresh);
              },
            },
          },
          kind,
          newName,
          zone,
          h('button', { type: 'submit' }, 'Add room'),
        )
      : null,
  );
}

function itemsSection(house: HouseDetail, canEdit: boolean, refresh: () => void): HTMLElement {
  const visibleAreas = house.areas;
  const rows = house.items.map((item) => {
    let where: HTMLElement;
    if (item.wholeHouse) {
      where = h('span', { class: 'muted' }, 'Every indoor room');
    } else if (!canEdit) {
      where = h(
        'span',
        {},
        visibleAreas
          .filter((a) => item.areaIds.includes(a.id))
          .map((a) => a.name)
          .join(', ') || '—',
      );
    } else {
      const select = h(
        'select',
        { 'aria-label': `Where is the ${item.name}?` },
        h('option', { value: '' }, 'Not placed'),
        ...visibleAreas.map((a) =>
          h('option', { value: String(a.id), selected: item.areaIds[0] === a.id }, a.name),
        ),
      );
      select.addEventListener('change', () => {
        const areaIds = select.value ? [Number(select.value)] : [];
        void attempt(
          () => api('PUT', `/api/houses/${house.id}/items/${item.id}/placements`, { areaIds }),
          `Moved ${item.name}.`,
        );
      });
      where = h(
        'span',
        {},
        select,
        item.areaIds.length > 1
          ? h('span', { class: 'muted' }, ` (+${item.areaIds.length - 1} more)`)
          : null,
      );
    }
    return h(
      'tr',
      {},
      h('td', {}, item.name),
      h('td', {}, item.system ?? ''),
      h('td', {}, where),
      h(
        'td',
        {},
        canEdit
          ? h(
              'label',
              {},
              h('input', {
                type: 'checkbox',
                checked: !item.hidden,
                on: {
                  change: () =>
                    void attempt(() =>
                      api('PUT', `/api/houses/${house.id}/items/${item.id}/hidden`, {
                        hidden: !item.hidden,
                      }),
                    ).then(refresh),
                },
              }),
              ' We have this',
            )
          : item.hidden
            ? 'Not in this house'
            : '',
      ),
    );
  });
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Where things are'),
    h(
      'p',
      { class: 'muted' },
      'Move an item to the room it is in for this house. Its videos follow it in search and the 3D house.',
    ),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h('tr', {}, ...['Item', 'System', 'Room', ''].map((t) => h('th', { scope: 'col' }, t))),
        ),
        h('tbody', {}, ...rows),
      ),
    ),
  );
}

function membersSection(
  houseId: number,
  members: { email: string; role: HouseRole }[],
  isOwner: boolean,
  refresh: () => void,
): HTMLElement {
  const roles: HouseRole[] = ['owner', 'editor', 'viewer'];
  const rows = members.map((member) => {
    const role = h(
      'select',
      { 'aria-label': `Role of ${member.email}`, disabled: !isOwner },
      ...roles.map((r) => h('option', { value: r, selected: r === member.role }, r)),
    );
    role.addEventListener('change', () => {
      void attempt(
        () =>
          api('PUT', `/api/houses/${houseId}/members/${encodeURIComponent(member.email)}`, {
            role: role.value,
          }),
        'Role changed.',
      ).then(refresh);
    });
    return h(
      'tr',
      {},
      h('td', {}, member.email),
      h('td', {}, role),
      h(
        'td',
        {},
        isOwner
          ? h(
              'button',
              {
                type: 'button',
                class: 'danger',
                on: {
                  click: () => {
                    if (!window.confirm(`Remove ${member.email} from this house?`)) return;
                    void attempt(
                      () =>
                        api(
                          'DELETE',
                          `/api/houses/${houseId}/members/${encodeURIComponent(member.email)}`,
                        ),
                      'Removed.',
                    ).then(refresh);
                  },
                },
              },
              'Remove',
            )
          : null,
      ),
    );
  });
  const email = h('input', {
    type: 'email',
    placeholder: 'person@example.com',
    'aria-label': 'Email',
    required: true,
    maxlength: 320,
  });
  const newRole = h(
    'select',
    { 'aria-label': 'Role' },
    ...roles.map((r) => h('option', { value: r, selected: r === 'viewer' }, r)),
  );
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Members'),
    h('table', {}, h('tbody', {}, ...rows)),
    isOwner
      ? h(
          'form',
          {
            class: 'form-row',
            on: {
              submit: (event) => {
                event.preventDefault();
                void attempt(
                  () =>
                    api(
                      'PUT',
                      `/api/houses/${houseId}/members/${encodeURIComponent(email.value.trim())}`,
                      { role: newRole.value },
                    ),
                  'Member added.',
                ).then(refresh);
              },
            },
          },
          email,
          newRole,
          h('button', { type: 'submit' }, 'Add member'),
        )
      : null,
  );
}

function tagsSection(
  houseId: number,
  catalog: Catalog,
  canEdit: boolean,
  refresh: () => void,
): HTMLElement {
  const ours = catalog.tags.filter((t) => t.houseId === houseId);
  const name = h('input', {
    type: 'text',
    maxlength: 128,
    placeholder: 'New tag',
    'aria-label': 'New tag name',
    required: true,
  });
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'House tags'),
    ours.length
      ? h(
          'ul',
          { class: 'chips' },
          ...ours.map((t) =>
            h(
              'li',
              { class: 'chip' },
              t.name,
              canEdit
                ? h(
                    'button',
                    {
                      type: 'button',
                      class: 'danger',
                      'aria-label': `Delete tag ${t.name}`,
                      on: {
                        click: () => {
                          if (!window.confirm(`Delete the tag “${t.name}”?`)) return;
                          void attempt(
                            () => api('DELETE', `/api/tags/${t.id}`),
                            'Tag deleted.',
                          ).then(refresh);
                        },
                      },
                    },
                    '×',
                  )
                : null,
            ),
          ),
        )
      : h('p', { class: 'muted' }, 'No house tags yet.'),
    canEdit
      ? h(
          'form',
          {
            class: 'form-row',
            on: {
              submit: (event) => {
                event.preventDefault();
                void attempt(
                  () => api('POST', '/api/tags', { name: name.value, houseId }),
                  'Tag added.',
                ).then(refresh);
              },
            },
          },
          name,
          h('button', { type: 'submit' }, 'Add tag'),
        )
      : null,
  );
}

async function privateVideosSection(houseId: number): Promise<HTMLElement> {
  const jobs = await api<{ jobs: Job[] }>('GET', `/api/jobs${query({ houseId })}`);
  const list = jobList(jobs.jobs);
  return h(
    'section',
    { class: 'panel' },
    h('h2', {}, 'Add private videos'),
    h('p', { class: 'muted' }, 'Videos added here are only visible to members of this house.'),
    importForm(houseId, (jobId) => {
      notify(`Import #${jobId} queued. New videos will appear in the inbox.`);
    }),
    h('h2', {}, 'Recent imports'),
    list,
  );
}

void startPage('/house.html', run);
