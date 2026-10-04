import type { FastifyPluginCallback } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database, HouseRole } from '../db/schema.js';

export interface MeResponse {
  email: string;
  isAdmin: boolean;
  houses: { id: number; name: string; role: HouseRole }[];
}

export const meRoutes: FastifyPluginCallback<{ db: Kysely<Database> }> = (app, { db }, done) => {
  /** The signed-in user and the houses they belong to. */
  app.get('/api/me', async (request): Promise<MeResponse> => {
    const { email, isAdmin } = request.principal;
    const houses = await db
      .selectFrom('house_members as m')
      .innerJoin('houses as h', 'h.id', 'm.house_id')
      .select(['h.id', 'h.name', 'm.role'])
      .where('m.email', '=', email)
      .orderBy('h.name')
      .orderBy('h.id')
      .execute();
    return { email, isAdmin, houses };
  });
  done();
};
