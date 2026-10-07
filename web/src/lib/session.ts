/**
 * Who is signed in, which houses they can open, and which house is selected.
 * The selection lives in the URL (?house=ID) and in localStorage, so links can be
 * shared and the choice survives a reload.
 */
import { api } from './api';
import type { HouseRole, HouseSummary, Me } from './types';

const STORAGE_KEY = 'hb.houseId';

export interface Session {
  me: Me;
  houses: HouseSummary[];
  /** Selected house, or null for "shared library only". */
  house: HouseSummary | null;
}

function readStoredHouse(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeHouse(houseId: number | null): void {
  try {
    if (houseId === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(houseId));
  } catch {
    // Storage can be unavailable (private browsing); the URL still carries the choice.
  }
}

/** Picks the house from ?house=, then localStorage, then the only house if there is one. */
export function chooseHouse(
  houses: HouseSummary[],
  fromUrl: string | null,
  fromStorage: string | null,
): HouseSummary | null {
  for (const candidate of [fromUrl, fromStorage]) {
    if (candidate === null) continue;
    if (candidate === 'none') return null;
    const found = houses.find((h) => String(h.id) === candidate);
    if (found) return found;
  }
  return houses.length === 1 ? (houses[0] ?? null) : null;
}

export async function loadSession(): Promise<Session> {
  const me = await api<Me>('GET', '/api/me');
  const houses: HouseSummary[] = me.isAdmin
    ? (await api<{ houses: HouseSummary[] }>('GET', '/api/houses')).houses
    : me.houses;
  const url = new URL(window.location.href);
  const house = chooseHouse(houses, url.searchParams.get('house'), readStoredHouse());
  storeHouse(house?.id ?? null);
  return { me, houses, house };
}

export function roleIn(session: Session): HouseRole | null {
  return session.house?.role ?? null;
}

/** May edit the selected house's layout and private videos. */
export function canEditHouse(session: Session): boolean {
  const role = roleIn(session);
  return session.me.isAdmin || role === 'owner' || role === 'editor';
}

/** May edit a given video: shared ones need an admin, private ones a house editor. */
export function canEditVideo(session: Session, videoHouseId: number | null): boolean {
  if (session.me.isAdmin) return true;
  return videoHouseId !== null && videoHouseId === session.house?.id && canEditHouse(session);
}
