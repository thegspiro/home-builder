/** Shared page chrome: header with navigation and house selector, status messages. */
import { ApiError } from './api';
import { byId, h, replaceChildren } from './dom';
import { canEditHouse, loadSession, storeHouse, type Session } from './session';

interface NavLink {
  href: string;
  label: string;
  show: (s: Session) => boolean;
}

const NAV: NavLink[] = [
  { href: '/', label: 'Search', show: () => true },
  { href: '/list.html', label: 'List', show: () => true },
  { href: '/inbox.html', label: 'Inbox', show: (s) => s.me.isAdmin || canEditHouse(s) },
  { href: '/house.html', label: 'House', show: (s) => s.house !== null },
  { href: '/admin.html', label: 'Admin', show: (s) => s.me.isAdmin },
];

function houseSelector(session: Session): HTMLElement {
  const select = h(
    'select',
    {
      id: 'house-select',
      'aria-label': 'House',
      on: {
        change: () => {
          const value = select.value;
          storeHouse(value === 'none' ? null : Number(value));
          const url = new URL(window.location.href);
          url.searchParams.set('house', value);
          window.location.assign(url.toString());
        },
      },
    },
    h('option', { value: 'none' }, 'Shared library only'),
    ...session.houses.map((house) =>
      h(
        'option',
        { value: String(house.id), selected: house.id === session.house?.id },
        house.name,
      ),
    ),
  );
  return h('label', { class: 'house-picker' }, 'House ', select);
}

function renderHeader(session: Session, current: string): void {
  const nav = h(
    'nav',
    { 'aria-label': 'Main' },
    ...NAV.filter((link) => link.show(session)).map((link) =>
      h(
        'a',
        {
          href: link.href,
          'aria-current': link.href === current ? 'page' : undefined,
        },
        link.label,
      ),
    ),
  );
  replaceChildren(
    byId('site-header'),
    h('a', { class: 'brand', href: '/' }, 'Home Videos'),
    nav,
    session.houses.length > 0 ? houseSelector(session) : null,
    h('span', { class: 'who', title: session.me.email }, session.me.email),
  );
}

/** Shows a message in the page's status area (role=status, so screen readers hear it). */
export function notify(message: string, kind: 'info' | 'error' = 'info'): void {
  const area = document.getElementById('status');
  if (!area) return;
  replaceChildren(area, h('p', { class: `notice ${kind}` }, message));
  if (kind === 'info') {
    window.setTimeout(() => {
      if (area.textContent === message) area.replaceChildren();
    }, 5000);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
}

/** Runs an action, reporting failures in the status area. Returns false on failure. */
export async function attempt(action: () => Promise<unknown>, success?: string): Promise<boolean> {
  try {
    await action();
    if (success) notify(success);
    return true;
  } catch (error) {
    notify(errorMessage(error), 'error');
    return false;
  }
}

/** Loads the session, draws the header, then runs the page. */
export async function startPage(
  current: string,
  run: (session: Session) => Promise<void>,
): Promise<void> {
  let session: Session;
  try {
    session = await loadSession();
  } catch (error) {
    replaceChildren(byId('main'), h('p', { class: 'notice error' }, errorMessage(error)));
    return;
  }
  renderHeader(session, current);
  try {
    await run(session);
  } catch (error) {
    notify(errorMessage(error), 'error');
  }
}
