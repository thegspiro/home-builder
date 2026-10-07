import { describe, expect, it } from 'vitest';
import { areaParams } from '../src/lib/filters';
import { videoTitle } from '../src/lib/format';
import { canEditVideo, chooseHouse, type Session } from '../src/lib/session';
import type { HouseSummary } from '../src/lib/types';

const houses: HouseSummary[] = [
  { id: 1, name: 'Home', role: 'owner' },
  { id: 2, name: 'Cabin', role: 'viewer' },
];

describe('chooseHouse', () => {
  it('prefers the URL, then storage', () => {
    expect(chooseHouse(houses, '2', '1')?.id).toBe(2);
    expect(chooseHouse(houses, null, '1')?.id).toBe(1);
  });

  it('honours an explicit "none"', () => {
    expect(chooseHouse(houses, 'none', '1')).toBeNull();
  });

  it('ignores houses the user cannot see', () => {
    expect(chooseHouse(houses, '99', '98')).toBeNull();
    expect(chooseHouse(houses, '99', '2')?.id).toBe(2);
  });

  it('picks the only house automatically', () => {
    expect(chooseHouse([houses[0]!], null, null)?.id).toBe(1);
    expect(chooseHouse(houses, null, null)).toBeNull();
  });
});

function session(isAdmin: boolean, house: HouseSummary | null): Session {
  return { me: { email: 'a@b.co', isAdmin, houses: [] }, houses, house };
}

describe('canEditVideo', () => {
  it('lets admins edit everything', () => {
    expect(canEditVideo(session(true, null), null)).toBe(true);
  });

  it('lets house owners and editors edit only their private videos', () => {
    expect(canEditVideo(session(false, houses[0]!), 1)).toBe(true);
    expect(canEditVideo(session(false, houses[0]!), null)).toBe(false);
    expect(canEditVideo(session(false, houses[0]!), 2)).toBe(false);
    expect(canEditVideo(session(false, houses[1]!), 2)).toBe(false);
  });
});

describe('areaParams', () => {
  it.each([
    ['room:5', { houseAreaId: 5 }],
    ['type:3', { areaTypeId: 3 }],
    ['', {}],
    ['room:abc', {}],
    ['room:-1', {}],
    ['other:3', {}],
  ])('%s', (value, expected) => {
    expect(areaParams(value)).toEqual(expected);
  });
});

describe('videoTitle', () => {
  it('describes missing titles', () => {
    expect(videoTitle('Fix it', 'ok')).toBe('Fix it');
    expect(videoTitle(null, 'pending')).toMatch(/fetching/);
    expect(videoTitle(null, 'unavailable')).toBe('Unavailable video');
  });
});
