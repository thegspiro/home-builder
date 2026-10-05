/**
 * Video search and listing (docs/PLAN.md section 7: Search and List views).
 *
 * Visibility: shared videos, plus the private videos of `houseId` when one is given
 * (callers must have authorized the house first).
 *
 * "Videos in house area X" follows section 5.1. A video belongs to X when it is linked to
 * X's area type, or to an item placed in X (not hidden in that house), or (if it is private)
 * directly to X. Whole-house items count for every interior area.
 */
import { sql, type Expression, type ExpressionBuilder, type Kysely, type SqlBool } from 'kysely';
import type { Database, ReviewStatus } from '../db/schema.js';
import { ValidationError } from '../http/errors.js';
import { toVideoViews, type VideoView } from './view.js';

export type SearchSort = 'newest' | 'oldest' | 'title';

export interface SearchParams {
  houseId: number | null;
  q?: string;
  tagIds: number[];
  areaTypeId?: number;
  itemId?: number;
  houseAreaId?: number;
  status: ReviewStatus | 'all';
  sort: SearchSort;
  limit: number;
  offset: number;
}

export interface SearchResult {
  total: number;
  videos: VideoView[];
}

/** InnoDB's built-in full-text stopwords; a required stopword would match nothing. */
const STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'are',
  'as',
  'at',
  'be',
  'by',
  'com',
  'de',
  'en',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'la',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'who',
  'will',
  'with',
  'und',
  'www',
]);
/** innodb_ft_min_token_size default: shorter words are not in the full-text index. */
const MIN_FT_LENGTH = 3;
const MAX_TERMS = 10;

/** Zones of interior rooms; whole-house items (thermostat, outlets…) belong to each. */
export const INTERIOR_ZONES = [
  'kitchen',
  'bathroom',
  'bedroom',
  'living-room',
  'laundry',
  'basement',
  'attic',
  'garage',
] as const;

export interface ParsedQuery {
  /** For MATCH … AGAINST in boolean mode, e.g. "+garag* +door*". Empty when unused. */
  fullText: string;
  /** Short words (like "ac") matched as whole words with a regular expression. */
  shortWords: string[];
}

/**
 * Splits free text into letter/digit words. Every word is required (AND). Operators and
 * punctuation in the input are dropped, so nothing the user types reaches MySQL's
 * boolean-mode syntax or the regular expression unescaped.
 */
export function parseQuery(q: string | undefined): ParsedQuery {
  const words = (q ?? '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(words)].slice(0, MAX_TERMS);
  const long = unique.filter((w) => w.length >= MIN_FT_LENGTH && !STOPWORDS.has(w));
  const short = unique.filter((w) => w.length < MIN_FT_LENGTH && !STOPWORDS.has(w));
  return { fullText: long.map((w) => `+${w}*`).join(' '), shortWords: short };
}

type Eb = ExpressionBuilder<Database, 'videos'>;

function inHouseArea(
  eb: Eb,
  houseId: number,
  areaId: number,
  interior: boolean,
): Expression<SqlBool> {
  const viaAreaType = eb.exists(
    eb
      .selectFrom('video_area_types as vat')
      .innerJoin('house_areas as ha', 'ha.area_type_id', 'vat.area_type_id')
      .select(sql.lit(1).as('one'))
      .whereRef('vat.video_id', '=', 'videos.id')
      .where('ha.id', '=', areaId),
  );
  const viaPlacedItem = eb.exists(
    eb
      .selectFrom('video_items as vi')
      .innerJoin('house_item_placements as p', 'p.item_id', 'vi.item_id')
      .select(sql.lit(1).as('one'))
      .whereRef('vi.video_id', '=', 'videos.id')
      .where('p.house_id', '=', houseId)
      .where('p.house_area_id', '=', areaId)
      .where((qb) =>
        qb.not(
          qb.exists(
            qb
              .selectFrom('house_hidden_items as hh')
              .select(sql.lit(1).as('one'))
              .whereRef('hh.item_id', '=', 'vi.item_id')
              .where('hh.house_id', '=', houseId),
          ),
        ),
      ),
  );
  const viaDirectLink = eb.exists(
    eb
      .selectFrom('video_house_areas as vh')
      .select(sql.lit(1).as('one'))
      .whereRef('vh.video_id', '=', 'videos.id')
      .where('vh.house_area_id', '=', areaId),
  );
  const branches = [viaAreaType, viaPlacedItem, viaDirectLink];
  if (interior) {
    branches.push(
      eb.exists(
        eb
          .selectFrom('video_items as vi')
          .innerJoin('items as i', 'i.id', 'vi.item_id')
          .select(sql.lit(1).as('one'))
          .whereRef('vi.video_id', '=', 'videos.id')
          .where('i.whole_house', '=', 1)
          .where((qb) =>
            qb.not(
              qb.exists(
                qb
                  .selectFrom('house_hidden_items as hh')
                  .select(sql.lit(1).as('one'))
                  .whereRef('hh.item_id', '=', 'vi.item_id')
                  .where('hh.house_id', '=', houseId),
              ),
            ),
          ),
      ),
    );
  }
  return eb.or(branches);
}

export async function searchVideos(
  db: Kysely<Database>,
  params: SearchParams,
): Promise<SearchResult> {
  let area: { zone: string } | undefined;
  if (params.houseAreaId !== undefined) {
    if (params.houseId === null) throw new ValidationError('houseAreaId needs a houseId');
    area = await db
      .selectFrom('house_areas')
      .select('zone')
      .where('id', '=', params.houseAreaId)
      .where('house_id', '=', params.houseId)
      .executeTakeFirst();
    if (!area) throw new ValidationError('That area does not belong to this house');
  }
  const { fullText, shortWords } = parseQuery(params.q);

  let query = db
    .selectFrom('videos')
    .where((eb) =>
      params.houseId === null
        ? eb('house_id', 'is', null)
        : eb.or([eb('house_id', 'is', null), eb('house_id', '=', params.houseId)]),
    );
  if (params.status !== 'all') query = query.where('review_status', '=', params.status);
  if (fullText) {
    query = query.where(
      sql<SqlBool>`MATCH(title, channel_name, notes) AGAINST (${fullText} IN BOOLEAN MODE)`,
    );
  }
  for (const word of shortWords) {
    // Words are letters/digits only (see parseQuery), so the pattern needs no escaping.
    const pattern = `\\b${word}\\b`;
    query = query.where(
      sql<SqlBool>`REGEXP_LIKE(CONCAT_WS(' ', title, channel_name, notes), ${pattern}, 'i')`,
    );
  }
  for (const tagId of params.tagIds) {
    query = query.where((qb) =>
      qb.exists(
        qb
          .selectFrom('video_tags as vt')
          .select(sql.lit(1).as('one'))
          .whereRef('vt.video_id', '=', 'videos.id')
          .where('vt.tag_id', '=', tagId),
      ),
    );
  }
  if (params.areaTypeId !== undefined) {
    const areaTypeId = params.areaTypeId;
    query = query.where((qb) =>
      qb.exists(
        qb
          .selectFrom('video_area_types as va')
          .select(sql.lit(1).as('one'))
          .whereRef('va.video_id', '=', 'videos.id')
          .where('va.area_type_id', '=', areaTypeId),
      ),
    );
  }
  if (params.itemId !== undefined) {
    const itemId = params.itemId;
    query = query.where((qb) =>
      qb.exists(
        qb
          .selectFrom('video_items as vi')
          .select(sql.lit(1).as('one'))
          .whereRef('vi.video_id', '=', 'videos.id')
          .where('vi.item_id', '=', itemId),
      ),
    );
  }
  if (area && params.houseId !== null && params.houseAreaId !== undefined) {
    const { houseId, houseAreaId } = params;
    const interior = (INTERIOR_ZONES as readonly string[]).includes(area.zone);
    query = query.where((eb) => inHouseArea(eb, houseId, houseAreaId, interior));
  }

  const totalRow = await query.select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
  let page = query.select([
    'videos.id',
    'videos.youtube_id',
    'videos.house_id',
    'videos.title',
    'videos.channel_name',
    'videos.thumbnail_url',
    'videos.source',
    'videos.metadata_status',
    'videos.review_status',
    'videos.created_at',
  ]);
  switch (params.sort) {
    case 'oldest':
      page = page.orderBy('videos.id', 'asc');
      break;
    case 'title':
      // Untitled videos (metadata pending) go last.
      page = page
        .orderBy(sql`videos.title IS NULL`)
        .orderBy('videos.title')
        .orderBy('videos.id');
      break;
    case 'newest':
      page = page.orderBy('videos.id', 'desc');
      break;
  }
  const rows = await page.limit(params.limit).offset(params.offset).execute();
  return { total: Number(totalRow?.n ?? 0), videos: await toVideoViews(db, rows) };
}
