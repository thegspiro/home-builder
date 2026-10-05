/**
 * Single source of truth for who may do what (docs/PLAN.md section 6).
 * Route handlers must call `can` / `assertCan` rather than checking roles themselves.
 */
import type { HouseRole } from '../db/schema.js';

export interface Principal {
  email: string;
  isAdmin: boolean;
}

export type LibraryAction =
  /** Browse the shared library. */
  | 'library.view'
  /** Edit shared videos, shared tags, keyword rules, area types, items, playlists, CSV import. */
  | 'library.edit'
  /** Create or delete houses. */
  | 'house.create'
  | 'house.delete';

export type HouseAction =
  /** See the house, its layout and its private videos. */
  | 'house.view'
  /** Rename the house. */
  | 'house.settings.edit'
  /** Add, change or remove house members. */
  | 'house.members.manage'
  /** Add, rename or hide areas; move or hide items. */
  | 'house.layout.edit'
  /** Add or edit private videos, one at a time or in bulk. */
  | 'house.videos.edit'
  /** Create or edit house tags and apply tags to private videos. */
  | 'house.tags.edit';

export type Action = LibraryAction | HouseAction;

const HOUSE_ACTIONS: Readonly<Record<HouseAction, readonly HouseRole[]>> = {
  'house.view': ['owner', 'editor', 'viewer'],
  'house.settings.edit': ['owner'],
  'house.members.manage': ['owner'],
  'house.layout.edit': ['owner', 'editor'],
  'house.videos.edit': ['owner', 'editor'],
  'house.tags.edit': ['owner', 'editor'],
};

function isHouseAction(action: Action): action is HouseAction {
  return Object.hasOwn(HOUSE_ACTIONS, action);
}

/**
 * @param houseRole the principal's role in the house the action targets, or null if
 *   they are not a member. Ignored for library actions.
 */
export function can(
  principal: Principal,
  action: Action,
  houseRole: HouseRole | null = null,
): boolean {
  if (principal.isAdmin) return true;
  if (!isHouseAction(action)) {
    return action === 'library.view';
  }
  return houseRole !== null && HOUSE_ACTIONS[action].includes(houseRole);
}

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(readonly action: Action) {
    super(`Not allowed: ${action}`);
    this.name = 'ForbiddenError';
  }
}

export function assertCan(
  principal: Principal,
  action: Action,
  houseRole: HouseRole | null = null,
): void {
  if (!can(principal, action, houseRole)) {
    throw new ForbiddenError(action);
  }
}
