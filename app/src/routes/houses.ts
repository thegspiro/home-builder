/**
 * House management API (docs/PLAN.md sections 6–7, Phase 2).
 *
 *   GET    /api/houses                                     houses the caller can see
 *   POST   /api/houses                                     create (global admin)
 *   GET    /api/houses/:houseId                            layout: areas + items
 *   PATCH  /api/houses/:houseId                            rename (owner)
 *   DELETE /api/houses/:houseId                            delete (global admin)
 *   GET    /api/houses/:houseId/members                    list members
 *   PUT    /api/houses/:houseId/members/:email             add or change a member (owner)
 *   DELETE /api/houses/:houseId/members/:email             remove a member (owner)
 *   POST   /api/houses/:houseId/areas                      add an area (owner/editor)
 *   PATCH  /api/houses/:houseId/areas/:areaId              rename/hide/move an area
 *   DELETE /api/houses/:houseId/areas/:areaId              delete an area
 *   PUT    /api/houses/:houseId/items/:itemId/placements   set where an item sits
 *   PUT    /api/houses/:houseId/items/:itemId/hidden       hide/show an item
 */
import type { FastifyPluginCallback } from 'fastify';
import type { Kysely } from 'kysely';
import { assertCan } from '../auth/policy.js';
import { normalizeEmail } from '../config.js';
import type { Database, HouseRole } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
import { requireHouse } from '../houses/access.js';
import {
  createArea,
  createHouse,
  deleteArea,
  deleteHouse,
  getHouseDetail,
  listHouses,
  listMembers,
  removeMember,
  renameHouse,
  setItemHidden,
  setItemPlacements,
  setMember,
  updateArea,
  type AreaInput,
} from '../houses/service.js';
import { HOUSE_ZONES } from '../houses/zones.js';

const ID = { type: 'integer', minimum: 1, maximum: 4294967295 } as const;
const NAME = { type: 'string', minLength: 1, maxLength: 128 } as const;
const EMAIL = {
  type: 'string',
  minLength: 3,
  maxLength: 320,
  pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$',
} as const;
const ROLE = { type: 'string', enum: ['owner', 'editor', 'viewer'] } as const;
const ZONE = { type: 'string', enum: HOUSE_ZONES } as const;

const houseParams = {
  type: 'object',
  required: ['houseId'],
  properties: { houseId: ID },
} as const;

const areaParams = {
  type: 'object',
  required: ['houseId', 'areaId'],
  properties: { houseId: ID, areaId: ID },
} as const;

const itemParams = {
  type: 'object',
  required: ['houseId', 'itemId'],
  properties: { houseId: ID, itemId: ID },
} as const;

const memberParams = {
  type: 'object',
  required: ['houseId', 'email'],
  properties: { houseId: ID, email: EMAIL },
} as const;

interface HouseParams {
  houseId: number;
}
interface AreaParams extends HouseParams {
  areaId: number;
}
interface ItemParams extends HouseParams {
  itemId: number;
}
interface MemberParams extends HouseParams {
  email: string;
}
interface AreaBody {
  name?: string;
  areaTypeId?: number | null;
  zone?: string;
  hidden?: boolean;
  sortOrder?: number;
}

/** Trims a name and rejects one that is blank after trimming. */
function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ValidationError('name must not be blank');
  return trimmed;
}

function toAreaInput(body: AreaBody): AreaInput {
  const input: AreaInput = {};
  if (body.name !== undefined) input.name = cleanName(body.name);
  if (body.areaTypeId !== undefined) input.areaTypeId = body.areaTypeId;
  if (body.zone !== undefined) input.zone = body.zone;
  if (body.hidden !== undefined) input.hidden = body.hidden;
  if (body.sortOrder !== undefined) input.sortOrder = body.sortOrder;
  return input;
}

const areaBodyProperties = {
  name: NAME,
  areaTypeId: { anyOf: [ID, { type: 'null' }] },
  zone: ZONE,
  hidden: { type: 'boolean' },
  sortOrder: { type: 'integer', minimum: -1000000, maximum: 1000000 },
} as const;

export const houseRoutes: FastifyPluginCallback<{ db: Kysely<Database> }> = (app, { db }, done) => {
  // ------------------------------------------------------------ houses

  app.get('/api/houses', async (request) => ({ houses: await listHouses(db, request.principal) }));

  app.post<{ Body: { name: string; ownerEmail?: string } }>(
    '/api/houses',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: NAME, ownerEmail: EMAIL },
        },
      },
    },
    async (request, reply) => {
      assertCan(request.principal, 'house.create');
      const id = await createHouse(db, request.principal, {
        name: cleanName(request.body.name),
        ownerEmail: normalizeEmail(request.body.ownerEmail ?? request.principal.email),
      });
      request.log.info({ houseId: id }, 'house created');
      return reply.code(201).send({ id });
    },
  );

  app.get<{ Params: HouseParams }>(
    '/api/houses/:houseId',
    { schema: { params: houseParams } },
    async (request) => {
      const { houseId } = request.params;
      const { role } = await requireHouse(db, request.principal, houseId, 'house.view');
      return getHouseDetail(db, houseId, role);
    },
  );

  app.patch<{ Params: HouseParams; Body: { name: string } }>(
    '/api/houses/:houseId',
    {
      schema: {
        params: houseParams,
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: NAME },
        },
      },
    },
    async (request, reply) => {
      const { houseId } = request.params;
      await requireHouse(db, request.principal, houseId, 'house.settings.edit');
      await renameHouse(db, request.principal, houseId, cleanName(request.body.name));
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: HouseParams }>(
    '/api/houses/:houseId',
    { schema: { params: houseParams } },
    async (request, reply) => {
      assertCan(request.principal, 'house.delete');
      await deleteHouse(db, request.principal, request.params.houseId);
      request.log.info({ houseId: request.params.houseId }, 'house deleted');
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------ members

  app.get<{ Params: HouseParams }>(
    '/api/houses/:houseId/members',
    { schema: { params: houseParams } },
    async (request) => {
      const { houseId } = request.params;
      await requireHouse(db, request.principal, houseId, 'house.view');
      return { members: await listMembers(db, houseId) };
    },
  );

  app.put<{ Params: MemberParams; Body: { role: HouseRole } }>(
    '/api/houses/:houseId/members/:email',
    {
      schema: {
        params: memberParams,
        body: {
          type: 'object',
          required: ['role'],
          additionalProperties: false,
          properties: { role: ROLE },
        },
      },
    },
    async (request, reply) => {
      const { houseId } = request.params;
      const email = normalizeEmail(request.params.email);
      await requireHouse(db, request.principal, houseId, 'house.members.manage');
      const { created } = await setMember(db, request.principal, houseId, email, request.body.role);
      return reply.code(created ? 201 : 200).send({ email, role: request.body.role });
    },
  );

  app.delete<{ Params: MemberParams }>(
    '/api/houses/:houseId/members/:email',
    { schema: { params: memberParams } },
    async (request, reply) => {
      const { houseId } = request.params;
      await requireHouse(db, request.principal, houseId, 'house.members.manage');
      await removeMember(db, request.principal, houseId, normalizeEmail(request.params.email));
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------ areas

  app.post<{ Params: HouseParams; Body: AreaBody }>(
    '/api/houses/:houseId/areas',
    {
      schema: {
        params: houseParams,
        body: { type: 'object', additionalProperties: false, properties: areaBodyProperties },
      },
    },
    async (request, reply) => {
      const { houseId } = request.params;
      await requireHouse(db, request.principal, houseId, 'house.layout.edit');
      const id = await createArea(db, request.principal, houseId, toAreaInput(request.body));
      return reply.code(201).send({ id });
    },
  );

  app.patch<{ Params: AreaParams; Body: AreaBody }>(
    '/api/houses/:houseId/areas/:areaId',
    {
      schema: {
        params: areaParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: areaBodyProperties,
        },
      },
    },
    async (request, reply) => {
      const { houseId, areaId } = request.params;
      await requireHouse(db, request.principal, houseId, 'house.layout.edit');
      await updateArea(db, request.principal, houseId, areaId, toAreaInput(request.body));
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: AreaParams }>(
    '/api/houses/:houseId/areas/:areaId',
    { schema: { params: areaParams } },
    async (request, reply) => {
      const { houseId, areaId } = request.params;
      await requireHouse(db, request.principal, houseId, 'house.layout.edit');
      await deleteArea(db, request.principal, houseId, areaId);
      return reply.code(204).send();
    },
  );

  // ------------------------------------------------------------ items

  app.put<{ Params: ItemParams; Body: { areaIds: number[] } }>(
    '/api/houses/:houseId/items/:itemId/placements',
    {
      schema: {
        params: itemParams,
        body: {
          type: 'object',
          required: ['areaIds'],
          additionalProperties: false,
          properties: { areaIds: { type: 'array', items: ID, maxItems: 100 } },
        },
      },
    },
    async (request, reply) => {
      const { houseId, itemId } = request.params;
      await requireHouse(db, request.principal, houseId, 'house.layout.edit');
      await setItemPlacements(db, request.principal, houseId, itemId, request.body.areaIds);
      return reply.code(204).send();
    },
  );

  app.put<{ Params: ItemParams; Body: { hidden: boolean } }>(
    '/api/houses/:houseId/items/:itemId/hidden',
    {
      schema: {
        params: itemParams,
        body: {
          type: 'object',
          required: ['hidden'],
          additionalProperties: false,
          properties: { hidden: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const { houseId, itemId } = request.params;
      await requireHouse(db, request.principal, houseId, 'house.layout.edit');
      await setItemHidden(db, request.principal, houseId, itemId, request.body.hidden);
      return reply.code(204).send();
    },
  );

  done();
};
