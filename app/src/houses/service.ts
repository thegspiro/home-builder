/**
 * House, member, area and item-placement operations (docs/PLAN.md sections 5–6).
 *
 * Every function here assumes the caller has already been authorized with
 * `requireHouse` (or `assertCan` for house creation/deletion). Every query that touches
 * a house-owned row also filters by house_id, so an ID from another house is treated
 * as "not found" rather than acted on.
 */
import { sql, type Kysely, type Transaction } from 'kysely';
import { writeAudit } from '../audit.js';
import type { Principal } from '../auth/policy.js';
import type { Database, HouseRole } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../http/errors.js';
import { isHouseZone, type HouseZone } from './zones.js';

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

export interface HouseSummary {
  id: number;
  name: string;
  /** The caller's role; null when an admin views a house they are not a member of. */
  role: HouseRole | null;
}

export interface HouseArea {
  id: number;
  name: string;
  areaTypeId: number | null;
  areaTypeSlug: string | null;
  zone: string;
  hidden: boolean;
  sortOrder: number;
}

export interface HouseItem {
  id: number;
  slug: string;
  name: string;
  system: string | null;
  wholeHouse: boolean;
  hidden: boolean;
  /** House areas the item is placed in. Always empty for whole-house items. */
  areaIds: number[];
}

export interface HouseDetail extends HouseSummary {
  areas: HouseArea[];
  items: HouseItem[];
}

export interface HouseMember {
  email: string;
  role: HouseRole;
}

// ---------------------------------------------------------------- houses

export async function listHouses(db: Db, principal: Principal): Promise<HouseSummary[]> {
  if (principal.isAdmin) {
    const rows = await db
      .selectFrom('houses as h')
      .leftJoin('house_members as m', (join) =>
        join.onRef('m.house_id', '=', 'h.id').on('m.email', '=', principal.email),
      )
      .select(['h.id', 'h.name', 'm.role'])
      .orderBy('h.name')
      .orderBy('h.id')
      .execute();
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role }));
  }
  return db
    .selectFrom('house_members as m')
    .innerJoin('houses as h', 'h.id', 'm.house_id')
    .select(['h.id', 'h.name', 'm.role'])
    .where('m.email', '=', principal.email)
    .orderBy('h.name')
    .orderBy('h.id')
    .execute();
}

/**
 * Creates a house with one area per non-system area type and the catalog's default
 * item placements, and makes `ownerEmail` its owner.
 */
export async function createHouse(
  db: Db,
  principal: Principal,
  input: { name: string; ownerEmail: string },
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const result = await trx
      .insertInto('houses')
      .values({ name: input.name, created_by: principal.email })
      .executeTakeFirstOrThrow();
    const houseId = Number(result.insertId);

    await trx
      .insertInto('house_members')
      .values({ house_id: houseId, email: input.ownerEmail, role: 'owner' })
      .execute();

    await sql`
      INSERT INTO house_areas (house_id, area_type_id, name, zone, sort_order)
      SELECT ${houseId}, a.id, a.name, a.default_zone, a.sort_order
      FROM area_types a
      WHERE a.category <> 'system'
    `.execute(trx);

    await sql`
      INSERT INTO house_item_placements (house_id, item_id, house_area_id)
      SELECT ${houseId}, p.item_id, ha.id
      FROM item_default_placements p
      INNER JOIN house_areas ha ON ha.area_type_id = p.area_type_id AND ha.house_id = ${houseId}
      INNER JOIN items i ON i.id = p.item_id AND i.whole_house = FALSE
    `.execute(trx);

    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: 'house.create',
      entity: 'house',
      entityId: houseId,
      details: { name: input.name, owner: input.ownerEmail },
    });
    return houseId;
  });
}

export async function getHouseDetail(
  db: Db,
  houseId: number,
  role: HouseRole | null,
): Promise<HouseDetail> {
  const house = await db
    .selectFrom('houses')
    .select(['id', 'name'])
    .where('id', '=', houseId)
    .executeTakeFirst();
  if (!house) throw new NotFoundError('House');

  const areas = await db
    .selectFrom('house_areas as ha')
    .leftJoin('area_types as at', 'at.id', 'ha.area_type_id')
    .select([
      'ha.id',
      'ha.name',
      'ha.area_type_id',
      'at.slug as area_type_slug',
      'ha.zone',
      'ha.hidden',
      'ha.sort_order',
    ])
    .where('ha.house_id', '=', houseId)
    .orderBy('ha.sort_order')
    .orderBy('ha.id')
    .execute();

  const items = await db
    .selectFrom('items as i')
    .leftJoin('area_types as s', 's.id', 'i.system_area_type_id')
    .leftJoin('house_hidden_items as hh', (join) =>
      join.onRef('hh.item_id', '=', 'i.id').on('hh.house_id', '=', houseId),
    )
    .select([
      'i.id',
      'i.slug',
      'i.name',
      's.slug as system',
      'i.whole_house',
      'hh.item_id as hidden_id',
    ])
    .orderBy('i.sort_order')
    .orderBy('i.id')
    .execute();

  const placements = await db
    .selectFrom('house_item_placements')
    .select(['item_id', 'house_area_id'])
    .where('house_id', '=', houseId)
    .orderBy('house_area_id')
    .execute();
  const areaIdsByItem = new Map<number, number[]>();
  for (const p of placements) {
    const list = areaIdsByItem.get(p.item_id) ?? [];
    list.push(p.house_area_id);
    areaIdsByItem.set(p.item_id, list);
  }

  return {
    id: house.id,
    name: house.name,
    role,
    areas: areas.map((a) => ({
      id: a.id,
      name: a.name,
      areaTypeId: a.area_type_id,
      areaTypeSlug: a.area_type_slug,
      zone: a.zone,
      hidden: a.hidden === 1,
      sortOrder: a.sort_order,
    })),
    items: items.map((i) => ({
      id: i.id,
      slug: i.slug,
      name: i.name,
      system: i.system,
      wholeHouse: i.whole_house === 1,
      hidden: i.hidden_id !== null,
      areaIds: areaIdsByItem.get(i.id) ?? [],
    })),
  };
}

export async function renameHouse(
  db: Db,
  principal: Principal,
  houseId: number,
  name: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('houses').set({ name }).where('id', '=', houseId).execute();
    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: 'house.rename',
      entity: 'house',
      entityId: houseId,
      details: { name },
    });
  });
}

/**
 * Deletes a house and everything it owns. Private videos and house tags are deleted
 * explicitly first: their foreign keys are RESTRICT (see migration 0001).
 */
export async function deleteHouse(db: Db, principal: Principal, houseId: number): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const house = await trx
      .selectFrom('houses')
      .select(['id', 'name'])
      .where('id', '=', houseId)
      .forUpdate()
      .executeTakeFirst();
    if (!house) throw new NotFoundError('House');

    const videos = await trx
      .deleteFrom('videos')
      .where('house_id', '=', houseId)
      .executeTakeFirst();
    const tags = await trx.deleteFrom('tags').where('house_id', '=', houseId).executeTakeFirst();
    await trx.deleteFrom('houses').where('id', '=', houseId).execute();

    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: 'house.delete',
      entity: 'house',
      entityId: houseId,
      details: {
        name: house.name,
        privateVideosDeleted: Number(videos.numDeletedRows),
        houseTagsDeleted: Number(tags.numDeletedRows),
      },
    });
  });
}

// ---------------------------------------------------------------- members

export async function listMembers(db: Db, houseId: number): Promise<HouseMember[]> {
  return db
    .selectFrom('house_members')
    .select(['email', 'role'])
    .where('house_id', '=', houseId)
    .orderBy('email')
    .execute();
}

/**
 * Serializes membership changes for one house. Every member mutation takes this lock
 * first, so concurrent changes queue in a fixed order instead of deadlocking on
 * member rows, and the last-owner check below always sees committed state.
 */
async function lockHouse(trx: Trx, houseId: number): Promise<void> {
  const house = await trx
    .selectFrom('houses')
    .select('id')
    .where('id', '=', houseId)
    .forUpdate()
    .executeTakeFirst();
  if (!house) throw new NotFoundError('House');
}

/** Fails if `email` is the house's only owner. Call after `lockHouse`. */
async function assertNotLastOwner(trx: Trx, houseId: number, email: string): Promise<void> {
  const owners = await trx
    .selectFrom('house_members')
    .select('email')
    .where('house_id', '=', houseId)
    .where('role', '=', 'owner')
    .execute();
  if (owners.length === 1 && owners[0]?.email === email) {
    throw new ConflictError('A house must keep at least one owner');
  }
}

export async function setMember(
  db: Db,
  principal: Principal,
  houseId: number,
  email: string,
  role: HouseRole,
): Promise<{ created: boolean }> {
  return db.transaction().execute(async (trx) => {
    await lockHouse(trx, houseId);
    const existing = await trx
      .selectFrom('house_members')
      .select('role')
      .where('house_id', '=', houseId)
      .where('email', '=', email)
      .executeTakeFirst();

    if (existing && existing.role === 'owner' && role !== 'owner') {
      await assertNotLastOwner(trx, houseId, email);
    }
    if (existing) {
      if (existing.role !== role) {
        await trx
          .updateTable('house_members')
          .set({ role })
          .where('house_id', '=', houseId)
          .where('email', '=', email)
          .execute();
      }
    } else {
      await trx.insertInto('house_members').values({ house_id: houseId, email, role }).execute();
    }

    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: existing ? 'member.update' : 'member.add',
      entity: 'house_member',
      entityId: email,
      details: { role, previousRole: existing?.role ?? null },
    });
    return { created: !existing };
  });
}

export async function removeMember(
  db: Db,
  principal: Principal,
  houseId: number,
  email: string,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await lockHouse(trx, houseId);
    const existing = await trx
      .selectFrom('house_members')
      .select('role')
      .where('house_id', '=', houseId)
      .where('email', '=', email)
      .executeTakeFirst();
    if (!existing) throw new NotFoundError('Member');
    if (existing.role === 'owner') {
      await assertNotLastOwner(trx, houseId, email);
    }
    await trx
      .deleteFrom('house_members')
      .where('house_id', '=', houseId)
      .where('email', '=', email)
      .execute();
    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: 'member.remove',
      entity: 'house_member',
      entityId: email,
      details: { role: existing.role },
    });
  });
}

// ---------------------------------------------------------------- areas

export interface AreaInput {
  name?: string;
  areaTypeId?: number | null;
  zone?: string;
  hidden?: boolean;
  sortOrder?: number;
}

/** Resolves an area type for use as a house area; system types are rejected. */
async function loadRoomAreaType(
  db: Db | Trx,
  areaTypeId: number,
): Promise<{ id: number; name: string; zone: HouseZone; sortOrder: number }> {
  const type = await db
    .selectFrom('area_types')
    .select(['id', 'name', 'category', 'default_zone', 'sort_order'])
    .where('id', '=', areaTypeId)
    .executeTakeFirst();
  if (!type) throw new ValidationError('Unknown area type');
  if (type.category === 'system' || !isHouseZone(type.default_zone)) {
    throw new ValidationError('System area types are overlays and cannot be house areas');
  }
  return { id: type.id, name: type.name, zone: type.default_zone, sortOrder: type.sort_order };
}

function checkZone(zone: string): HouseZone {
  if (!isHouseZone(zone)) throw new ValidationError(`Unknown zone "${zone}"`);
  return zone;
}

export async function createArea(
  db: Db,
  principal: Principal,
  houseId: number,
  input: AreaInput,
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const type =
      input.areaTypeId === undefined || input.areaTypeId === null
        ? null
        : await loadRoomAreaType(trx, input.areaTypeId);
    const name = input.name ?? type?.name;
    if (!name) throw new ValidationError('name is required for an area without an area type');
    const zone = input.zone !== undefined ? checkZone(input.zone) : type?.zone;
    if (!zone) throw new ValidationError('zone is required for an area without an area type');

    const maxOrder = await trx
      .selectFrom('house_areas')
      .select((eb) => eb.fn.max('sort_order').as('max'))
      .where('house_id', '=', houseId)
      .executeTakeFirst();
    const sortOrder = input.sortOrder ?? Number(maxOrder?.max ?? 0) + 10;

    const result = await trx
      .insertInto('house_areas')
      .values({
        house_id: houseId,
        area_type_id: type?.id ?? null,
        name,
        zone,
        hidden: input.hidden ?? false,
        sort_order: sortOrder,
      })
      .executeTakeFirstOrThrow();
    const areaId = Number(result.insertId);
    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: 'area.create',
      entity: 'house_area',
      entityId: areaId,
      details: { name, zone, areaTypeId: type?.id ?? null },
    });
    return areaId;
  });
}

export async function updateArea(
  db: Db,
  principal: Principal,
  houseId: number,
  areaId: number,
  input: AreaInput,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const area = await trx
      .selectFrom('house_areas')
      .select('id')
      .where('id', '=', areaId)
      .where('house_id', '=', houseId)
      .forUpdate()
      .executeTakeFirst();
    if (!area) throw new NotFoundError('Area');

    const changes: {
      name?: string;
      area_type_id?: number | null;
      zone?: HouseZone;
      hidden?: boolean;
      sort_order?: number;
    } = {};
    if (input.name !== undefined) changes.name = input.name;
    if (input.areaTypeId !== undefined) {
      changes.area_type_id =
        input.areaTypeId === null ? null : (await loadRoomAreaType(trx, input.areaTypeId)).id;
    }
    if (input.zone !== undefined) changes.zone = checkZone(input.zone);
    if (input.hidden !== undefined) changes.hidden = input.hidden;
    if (input.sortOrder !== undefined) changes.sort_order = input.sortOrder;
    if (Object.keys(changes).length === 0) return;

    await trx
      .updateTable('house_areas')
      .set(changes)
      .where('id', '=', areaId)
      .where('house_id', '=', houseId)
      .execute();
    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: 'area.update',
      entity: 'house_area',
      entityId: areaId,
      details: { ...input },
    });
  });
}

/** Deletes an area; its item placements and private-video links go with it. */
export async function deleteArea(
  db: Db,
  principal: Principal,
  houseId: number,
  areaId: number,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const area = await trx
      .selectFrom('house_areas')
      .select(['id', 'name'])
      .where('id', '=', areaId)
      .where('house_id', '=', houseId)
      .forUpdate()
      .executeTakeFirst();
    if (!area) throw new NotFoundError('Area');
    await trx
      .deleteFrom('house_areas')
      .where('id', '=', areaId)
      .where('house_id', '=', houseId)
      .execute();
    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: 'area.delete',
      entity: 'house_area',
      entityId: areaId,
      details: { name: area.name },
    });
  });
}

// ---------------------------------------------------------------- items

async function loadItem(
  db: Db | Trx,
  itemId: number,
): Promise<{ id: number; wholeHouse: boolean }> {
  const item = await db
    .selectFrom('items')
    .select(['id', 'whole_house'])
    .where('id', '=', itemId)
    .executeTakeFirst();
  if (!item) throw new NotFoundError('Item');
  return { id: item.id, wholeHouse: item.whole_house === 1 };
}

/** Replaces where an item sits in this house. An empty list un-places it. */
export async function setItemPlacements(
  db: Db,
  principal: Principal,
  houseId: number,
  itemId: number,
  areaIds: readonly number[],
): Promise<void> {
  const unique = [...new Set(areaIds)];
  await db.transaction().execute(async (trx) => {
    const item = await loadItem(trx, itemId);
    if (item.wholeHouse && unique.length > 0) {
      throw new ValidationError('Whole-house items appear in every area and cannot be placed');
    }
    if (unique.length > 0) {
      const found = await trx
        .selectFrom('house_areas')
        .select('id')
        .where('house_id', '=', houseId)
        .where('id', 'in', unique)
        .execute();
      if (found.length !== unique.length) {
        throw new ValidationError('Every area must belong to this house');
      }
    }

    await trx
      .deleteFrom('house_item_placements')
      .where('house_id', '=', houseId)
      .where('item_id', '=', itemId)
      .execute();
    if (unique.length > 0) {
      await trx
        .insertInto('house_item_placements')
        .values(
          unique.map((areaId) => ({ house_id: houseId, item_id: itemId, house_area_id: areaId })),
        )
        .execute();
    }
    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: 'item.place',
      entity: 'item',
      entityId: itemId,
      details: { areaIds: unique },
    });
  });
}

export async function setItemHidden(
  db: Db,
  principal: Principal,
  houseId: number,
  itemId: number,
  hidden: boolean,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await loadItem(trx, itemId);
    if (hidden) {
      await sql`
        INSERT INTO house_hidden_items (house_id, item_id) VALUES (${houseId}, ${itemId})
        ON DUPLICATE KEY UPDATE item_id = item_id
      `.execute(trx);
    } else {
      await trx
        .deleteFrom('house_hidden_items')
        .where('house_id', '=', houseId)
        .where('item_id', '=', itemId)
        .execute();
    }
    await writeAudit(trx, {
      actorEmail: principal.email,
      houseId,
      action: hidden ? 'item.hide' : 'item.show',
      entity: 'item',
      entityId: itemId,
    });
  });
}
