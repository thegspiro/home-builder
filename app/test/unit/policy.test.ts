import { describe, expect, it } from 'vitest';
import {
  assertCan,
  can,
  ForbiddenError,
  type Action,
  type Principal,
} from '../../src/auth/policy.js';
import type { HouseRole } from '../../src/db/schema.js';

type Actor = 'admin' | HouseRole | 'non-member';

const ADMIN: Principal = { email: 'admin@example.com', isAdmin: true };
const USER: Principal = { email: 'user@example.com', isAdmin: false };

/** docs/PLAN.md section 6, row by row. Columns: admin, owner, editor, viewer, non-member. */
const MATRIX: [Action, Record<Actor, boolean>][] = [
  ['library.view', { admin: true, owner: true, editor: true, viewer: true, 'non-member': true }],
  [
    'library.edit',
    { admin: true, owner: false, editor: false, viewer: false, 'non-member': false },
  ],
  [
    'house.create',
    { admin: true, owner: false, editor: false, viewer: false, 'non-member': false },
  ],
  [
    'house.delete',
    { admin: true, owner: false, editor: false, viewer: false, 'non-member': false },
  ],
  [
    'house.settings.edit',
    { admin: true, owner: true, editor: false, viewer: false, 'non-member': false },
  ],
  [
    'house.members.manage',
    { admin: true, owner: true, editor: false, viewer: false, 'non-member': false },
  ],
  [
    'house.layout.edit',
    { admin: true, owner: true, editor: true, viewer: false, 'non-member': false },
  ],
  [
    'house.videos.edit',
    { admin: true, owner: true, editor: true, viewer: false, 'non-member': false },
  ],
  [
    'house.tags.edit',
    { admin: true, owner: true, editor: true, viewer: false, 'non-member': false },
  ],
  ['house.view', { admin: true, owner: true, editor: true, viewer: true, 'non-member': false }],
];

const cases = MATRIX.flatMap(([action, expected]) =>
  (Object.entries(expected) as [Actor, boolean][]).map(([actor, allowed]) => ({
    action,
    actor,
    allowed,
  })),
);

describe('policy matrix', () => {
  it.each(cases)('$actor → $action = $allowed', ({ action, actor, allowed }) => {
    const principal = actor === 'admin' ? ADMIN : USER;
    const role = actor === 'admin' || actor === 'non-member' ? null : actor;
    expect(can(principal, action, role)).toBe(allowed);
  });

  it('a house role never grants library edits', () => {
    for (const role of ['owner', 'editor', 'viewer'] as const) {
      expect(can(USER, 'library.edit', role)).toBe(false);
      expect(can(USER, 'house.create', role)).toBe(false);
    }
  });
});

describe('assertCan', () => {
  it('throws ForbiddenError with status 403 when not allowed', () => {
    expect(() => assertCan(USER, 'house.layout.edit', 'viewer')).toThrow(ForbiddenError);
    try {
      assertCan(USER, 'library.edit');
    } catch (error) {
      expect((error as ForbiddenError).statusCode).toBe(403);
      expect((error as ForbiddenError).action).toBe('library.edit');
    }
  });

  it('does not throw when allowed', () => {
    expect(() => assertCan(USER, 'house.layout.edit', 'editor')).not.toThrow();
  });
});
