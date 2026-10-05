import { expect, test, type Page } from '@playwright/test';
import type { HouseDetail } from '../../src/houses/service.js';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/schema.js';
import { ADMIN, api, BASE_URL, signIn, testDb } from './harness.js';

const OWNER = 'owner@example.com';
const VIEWER = 'viewer@example.com';

let db: Kysely<Database>;
let houseId: number;
let house: HouseDetail;

async function id(table: 'tags' | 'area_types' | 'items', slug: string): Promise<number> {
  return (
    await db.selectFrom(table).select('id').where('slug', '=', slug).executeTakeFirstOrThrow()
  ).id;
}

async function addVideo(
  youtubeId: string,
  title: string,
  review: 'inbox' | 'sorted' = 'sorted',
): Promise<number> {
  const result = await db
    .insertInto('videos')
    .values({
      youtube_id: youtubeId,
      title,
      thumbnail_url: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
      source: 'manual',
      added_by: ADMIN,
      metadata_status: 'ok',
      review_status: review,
    })
    .executeTakeFirstOrThrow();
  return Number(result.insertId);
}

/** Fails the test on any script error or CSP violation in the page. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('net::ERR_FAILED'))
      errors.push(message.text());
  });
  return errors;
}

test.beforeAll(async () => {
  db = testDb();
  // Start clean: Playwright re-runs beforeAll in a fresh worker after a failure.
  for (const table of ['videos', 'keyword_rules', 'playlists', 'import_jobs'] as const) {
    await db.deleteFrom(table).execute();
  }
  await db.deleteFrom('tags').where('house_id', 'is not', null).execute();
  await db.deleteFrom('houses').execute();
  houseId = (
    await api<{ id: number }>(ADMIN, 'POST', '/api/houses', { name: 'Maple St', ownerEmail: OWNER })
  ).id;
  await api(OWNER, 'PUT', `/api/houses/${houseId}/members/${VIEWER}`, { role: 'viewer' });
  house = await api<HouseDetail>(OWNER, 'GET', `/api/houses/${houseId}`);

  const garageDoor = await addVideo('aaaaaaaaaaa', 'Insulating a garage door');
  const panel = await addVideo('bbbbbbbbbbb', 'Upgrading an electrical panel');
  await addVideo('ccccccccccc', 'Fixing a leaky kitchen faucet');
  await db
    .insertInto('video_area_types')
    .values({ video_id: garageDoor, area_type_id: await id('area_types', 'garage') })
    .execute();
  await db
    .insertInto('video_items')
    .values({ video_id: panel, item_id: await id('items', 'electrical-panel') })
    .execute();
  await db
    .insertInto('video_tags')
    .values({ video_id: panel, tag_id: await id('tags', 'electrical') })
    .execute();

  const inbox = await addVideo('ddddddddddd', 'How to replace a toilet flapper', 'inbox');
  await db
    .insertInto('video_items')
    .values({ video_id: inbox, item_id: await id('items', 'toilet'), suggested: true })
    .execute();
});

test.afterAll(async () => {
  await db?.destroy();
});

test('search finds videos by words and tags and plays them', async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(context, VIEWER);
  await page.goto(`${BASE_URL}/?house=none`);

  // Inbox videos are searchable too (shown with their suggestions).
  await expect(page.getByText('4 videos found')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search' }).fill('garage');
  await expect(page.getByText('1 video found')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Insulating a garage door' })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search' }).fill('');
  await page.getByRole('button', { name: 'Electrical', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Upgrading an electrical panel' })).toBeVisible();
  await expect(page.getByText('1 video found')).toBeVisible();
  expect(page.url()).toContain('tags=');

  await page.getByRole('button', { name: 'Play Upgrading an electrical panel' }).click();
  const frame = page.locator('dialog iframe');
  await expect(frame).toHaveAttribute(
    'src',
    /^https:\/\/www\.youtube-nocookie\.com\/embed\/bbbbbbbbbbb/,
  );
  await page.getByRole('button', { name: 'Close' }).click();
  expect(errors).toEqual([]);
});

test('moving the panel to the basement moves its video in room search', async ({
  page,
  context,
}) => {
  const errors = watchErrors(page);
  await signIn(context, OWNER);
  await page.goto(`${BASE_URL}/house.html?house=${houseId}`);
  await expect(page.getByRole('heading', { name: 'Maple St' })).toBeVisible();

  await page
    .getByRole('combobox', { name: 'Where is the Electrical panel (main)?' })
    .selectOption({ label: 'Basement' });
  await expect(page.getByText('Moved Electrical panel (main).')).toBeVisible();
  const basement = house.areas.find((a) => a.areaTypeSlug === 'basement')!;
  const placement = await db
    .selectFrom('house_item_placements')
    .select('house_area_id')
    .where('house_id', '=', houseId)
    .where('item_id', '=', await id('items', 'electrical-panel'))
    .execute();
  expect(placement).toEqual([{ house_area_id: basement.id }]);

  await page.goto(`${BASE_URL}/?house=${houseId}`);
  await page.getByRole('combobox', { name: 'Area' }).selectOption({ label: 'Basement' });
  await expect(page.getByRole('heading', { name: 'Upgrading an electrical panel' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Area' }).selectOption({ label: 'Garage' });
  await expect(page.getByRole('heading', { name: 'Insulating a garage door' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upgrading an electrical panel' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an admin confirms an inbox video with its suggestion', async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(context, ADMIN);
  await page.goto(`${BASE_URL}/inbox.html?house=none`);
  await expect(page.getByText('1 video to review')).toBeVisible();

  const item = page.getByRole('region', { name: 'How to replace a toilet flapper' });
  await expect(item.getByRole('checkbox', { name: /Toilet/ })).toBeChecked();
  await item.getByRole('checkbox', { name: /^Repair/ }).check();
  await item.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Nothing to review.')).toBeVisible();

  const video = await db
    .selectFrom('videos')
    .select(['id', 'review_status'])
    .where('youtube_id', '=', 'ddddddddddd')
    .executeTakeFirstOrThrow();
  expect(video.review_status).toBe('sorted');
  const tags = await db
    .selectFrom('video_tags')
    .select(['tag_id', 'suggested'])
    .where('video_id', '=', video.id)
    .execute();
  expect(tags).toEqual([{ tag_id: await id('tags', 'repair'), suggested: 0 }]);
  expect(errors).toEqual([]);
});

test('an admin adds a keyword rule and a playlist from the admin page', async ({
  page,
  context,
}) => {
  const errors = watchErrors(page);
  await signIn(context, ADMIN);
  await page.goto(`${BASE_URL}/admin.html`);

  await page.getByRole('textbox', { name: 'Phrase' }).fill('garage door');
  await page.getByRole('combobox', { name: 'Suggest' }).selectOption({ label: 'Garage' });
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByText('“garage door”')).toBeVisible();

  await page
    .getByRole('textbox', { name: 'Playlist URL' })
    .fill('https://www.youtube.com/playlist?list=PLtest1234567890abcdef');
  await page.getByRole('button', { name: 'Add playlist' }).click();
  await expect(page.getByText('Playlist added; first sync queued.')).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Playlist sync' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a viewer sees no editing controls', async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(context, VIEWER);
  await page.goto(`${BASE_URL}/house.html?house=${houseId}`);
  await expect(page.getByRole('heading', { name: 'Maple St' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Inbox' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add room' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add member' })).toHaveCount(0);

  await page.goto(`${BASE_URL}/list.html?house=${houseId}`);
  await expect(page.getByRole('button', { name: 'Insulating a garage door' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('signed-out requests get nothing', async ({ page }) => {
  const response = await page.goto(`${BASE_URL}/`);
  expect(response?.status()).toBe(401);
});
