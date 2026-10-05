import type { Kysely, Transaction } from 'kysely';
import { assertCan, type HouseAction, type Principal } from '../auth/policy.js';
import type { Database, HouseRole } from '../db/schema.js';
import { NotFoundError } from '../http/errors.js';

type Db = Kysely<Database> | Transaction<Database>;

export async function getHouseRole(
  db: Db,
  houseId: number,
  email: string,
): Promise<HouseRole | null> {
  const row = await db
    .selectFrom('house_members')
    .select('role')
    .where('house_id', '=', houseId)
    .where('email', '=', email)
    .executeTakeFirst();
  return row?.role ?? null;
}

/**
 * Loads the caller's role in a house and checks `action` against the policy.
 *
 * A house the caller cannot see (it doesn't exist, or they are not a member and not an
 * admin) is reported as 404, so house IDs can't be probed. A member who can see the
 * house but lacks the role for `action` gets 403.
 */
export async function requireHouse(
  db: Db,
  principal: Principal,
  houseId: number,
  action: HouseAction,
): Promise<{ role: HouseRole | null }> {
  const house = await db
    .selectFrom('houses')
    .select('id')
    .where('id', '=', houseId)
    .executeTakeFirst();
  const role = house ? await getHouseRole(db, houseId, principal.email) : null;
  if (!house || (role === null && !principal.isAdmin)) {
    throw new NotFoundError('House');
  }
  assertCan(principal, action, role);
  return { role };
}
