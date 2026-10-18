/** The 3D house page: clicking the model, the area menu, overlays, and the no-WebGL fallback. */
import { expect, test, type Page } from '@playwright/test';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/db/schema.js';
import type { HouseDetail } from '../../src/houses/service.js';
import {
  ADMIN,
  addVideo,
  api,
  BASE_URL,
  catalogId,
  resetContent,
  signIn,
  testDb,
  watchErrors,
} from './harness.js';

const OWNER = 'owner@example.com';
const VIEWER = 'viewer@example.com';

let db: Kysely<Database>;
let house: HouseDetail;

function areaId(slug: string): number {
  return house.areas.find((a) => a.areaTypeSlug === slug)!.id;
}

/** Clicks the model where an area's label is drawn (labels let clicks through). */
async function clickLabel(page: Page, name: string): Promise<void> {
  const label = page.locator('.model-label', { hasText: name }).first();
  await expect(label).toBeVisible();
  const box = (await label.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function openModel(page: Page, params = ''): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${BASE_URL}/model.html?house=${house.id}${params}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Oak Ave' })).toBeVisible();
}

const panel = (page: Page) => page.getByRole('region', { name: 'Videos for the selected area' });
/** The panel's title: the selected room, item or system. */
const title = (page: Page, name: string) =>
  panel(page).getByRole('heading', { level: 2, name, exact: true });
const level = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Level' }).getByRole('button', { name, exact: true });
const menuItem = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Areas' }).getByRole('button', { name, exact: true });

test.beforeAll(async () => {
  db = testDb();
  await resetContent(db);
  const created = await api<{ id: number }>(ADMIN, 'POST', '/api/houses', {
    name: 'Oak Ave',
    ownerEmail: OWNER,
  });
  await api(OWNER, 'PUT', `/api/houses/${created.id}/members/${VIEWER}`, { role: 'viewer' });
  house = await api<HouseDetail>(OWNER, 'GET', `/api/houses/${created.id}`);

  const faucet = await addVideo(db, 'kkkkkkkkkkk', 'Fixing a leaky kitchen faucet');
  const door = await addVideo(db, 'ggggggggggg', 'Insulating a garage door');
  const panelVideo = await addVideo(db, 'ppppppppppp', 'Upgrading an electrical panel');
  const wiring = await addVideo(db, 'wwwwwwwwwww', 'Wiring basics for homeowners');
  const shingles = await addVideo(db, 'sssssssssss', 'Replacing damaged shingles');
  await db
    .insertInto('video_area_types')
    .values([
      { video_id: faucet, area_type_id: await catalogId(db, 'area_types', 'kitchen') },
      { video_id: door, area_type_id: await catalogId(db, 'area_types', 'garage') },
      { video_id: wiring, area_type_id: await catalogId(db, 'area_types', 'electrical') },
    ])
    .execute();
  await db
    .insertInto('video_items')
    .values([
      { video_id: panelVideo, item_id: await catalogId(db, 'items', 'electrical-panel') },
      { video_id: shingles, item_id: await catalogId(db, 'items', 'shingles') },
    ])
    .execute();
});

test.afterAll(async () => {
  await db?.destroy();
});

test('clicking a room in the model shows its videos', async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(context, VIEWER);
  await openModel(page);
  const viewport = page.locator('#viewport');
  await expect(viewport).toHaveAttribute('data-mode', '3d');
  await expect(viewport).toHaveAttribute('data-rendered', 'true');
  await expect(level(page, 'Main floor')).toHaveAttribute('aria-pressed', 'true');

  await clickLabel(page, 'Kitchen');
  await expect(title(page, 'Kitchen')).toBeVisible();
  await expect(
    panel(page).getByRole('heading', { name: 'Fixing a leaky kitchen faucet' }),
  ).toBeVisible();
  expect(page.url()).toContain(`select=area%3A${areaId('kitchen')}`);
  await expect(menuItem(page, 'Kitchen')).toHaveAttribute('aria-current', 'true');

  // The outside of the house is its own level.
  await page.getByRole('button', { name: 'Reset camera' }).click();
  await level(page, 'Outside').click();
  await expect(page.locator('.model-label', { hasText: 'Kitchen' })).toBeHidden();
  await clickLabel(page, 'Roof & gutters');
  await expect(title(page, 'Roof & gutters')).toBeVisible();
  await expect(
    panel(page).getByRole('heading', { name: 'Replacing damaged shingles' }),
  ).toBeVisible();
  expect(page.url()).toContain('view=outside');
  expect(errors).toEqual([]);
});

test('the area list opens rooms, items and systems', async ({ page, context }) => {
  const errors = watchErrors(page);
  await signIn(context, VIEWER);
  await openModel(page);
  await menuItem(page, 'Garage').click();
  await expect(title(page, 'Garage')).toBeVisible();
  await expect(
    panel(page).getByRole('heading', { name: 'Insulating a garage door' }),
  ).toBeVisible();
  await panel(page).getByRole('button', { name: 'Electrical panel (main)' }).click();
  await expect(title(page, 'Electrical panel (main)')).toBeVisible();
  await expect(
    panel(page).getByRole('heading', { name: 'Upgrading an electrical panel' }),
  ).toBeVisible();

  // A system turns on its overlay and lists its videos.
  await menuItem(page, 'Electrical').click();
  await expect(title(page, 'Electrical')).toBeVisible();
  await expect(
    panel(page).getByRole('heading', { name: 'Wiring basics for homeowners' }),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Wiring', exact: true })).toBeChecked();
  const inPanel = panel(page).getByRole('checkbox', { name: 'Show wiring on the model' });
  await expect(inPanel).toBeChecked();
  await inPanel.uncheck();
  await expect(page.getByRole('checkbox', { name: 'Wiring', exact: true })).not.toBeChecked();

  // The basement is drawn on its own level, which the menu switches to.
  await menuItem(page, 'Basement').click();
  await expect(level(page, 'Basement')).toHaveAttribute('aria-pressed', 'true');
  expect(page.url()).toContain('view=basement');

  // Links to a selection open it directly.
  await page.goto(`${BASE_URL}/model.html?house=${house.id}&select=area:${areaId('garage')}`);
  await expect(title(page, 'Garage')).toBeVisible();
  expect(errors).toEqual([]);
});

test('moving the panel to the basement moves it in the model', async ({ page, context }) => {
  const errors = watchErrors(page);
  const panelItem = house.items.find((i) => i.slug === 'electrical-panel')!;
  await api(OWNER, 'PUT', `/api/houses/${house.id}/items/${panelItem.id}/placements`, {
    areaIds: [areaId('basement')],
  });
  await signIn(context, OWNER);
  await openModel(page, `&select=area:${areaId('basement')}`);
  await expect(level(page, 'Basement')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel(page).getByRole('button', { name: 'Electrical panel (main)' })).toBeVisible();
  await expect(
    panel(page).getByRole('heading', { name: 'Upgrading an electrical panel' }),
  ).toBeVisible();

  await menuItem(page, 'Garage').click();
  await expect(title(page, 'Garage')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Electrical panel (main)' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Change rooms and where things are' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('without WebGL the area list still works', async ({ page, context }) => {
  const errors = watchErrors(page);
  // Runs in the page before its scripts: no WebGL contexts, like a browser without a GPU.
  await page.addInitScript({
    content: `
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return String(type).startsWith('webgl') ? null : original.call(this, type, ...rest);
      };
    `,
  });
  await signIn(context, VIEWER);
  await openModel(page);
  await expect(page.locator('#viewport')).toHaveAttribute('data-mode', 'menu');
  await expect(page.getByText('The 3D view isn’t available in this browser.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Level' })).toHaveCount(0);

  await menuItem(page, 'Kitchen').click();
  await expect(
    panel(page).getByRole('heading', { name: 'Fixing a leaky kitchen faucet' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
