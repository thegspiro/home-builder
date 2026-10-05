/** The JSON shape of a video in API responses, with its tags, areas and items. */
import type { Kysely } from 'kysely';
import type { Database, MetadataStatus, ReviewStatus, VideoSource } from '../db/schema.js';

export interface Link {
  id: number;
  name: string;
  suggested: boolean;
}

export interface VideoView {
  id: number;
  youtubeId: string;
  houseId: number | null;
  title: string | null;
  channelName: string | null;
  thumbnailUrl: string | null;
  source: VideoSource;
  metadataStatus: MetadataStatus;
  reviewStatus: ReviewStatus;
  createdAt: Date;
  tags: Link[];
  areaTypes: Link[];
  items: Link[];
  houseAreas: { id: number; name: string }[];
}

/** Columns every caller selects from `videos` (aliased as `v` or unaliased). */
export const VIDEO_COLUMNS = [
  'id',
  'youtube_id',
  'house_id',
  'title',
  'channel_name',
  'thumbnail_url',
  'source',
  'metadata_status',
  'review_status',
  'created_at',
] as const;

export interface VideoRow {
  id: number;
  youtube_id: string;
  house_id: number | null;
  title: string | null;
  channel_name: string | null;
  thumbnail_url: string | null;
  source: VideoSource;
  metadata_status: MetadataStatus;
  review_status: ReviewStatus;
  created_at: Date;
}

function groupBy<T extends { video_id: number }>(rows: T[]): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const list = map.get(row.video_id) ?? [];
    list.push(row);
    map.set(row.video_id, list);
  }
  return map;
}

/** Adds tags, area types, items and house areas to a page of videos (4 queries total). */
export async function toVideoViews(db: Kysely<Database>, videos: VideoRow[]): Promise<VideoView[]> {
  const ids = videos.map((v) => v.id);
  if (ids.length === 0) return [];

  const [tags, areas, items, houseAreas] = await Promise.all([
    db
      .selectFrom('video_tags as vt')
      .innerJoin('tags as t', 't.id', 'vt.tag_id')
      .select(['vt.video_id', 't.id', 't.name', 'vt.suggested'])
      .where('vt.video_id', 'in', ids)
      .orderBy('t.name')
      .execute(),
    db
      .selectFrom('video_area_types as va')
      .innerJoin('area_types as a', 'a.id', 'va.area_type_id')
      .select(['va.video_id', 'a.id', 'a.name', 'va.suggested'])
      .where('va.video_id', 'in', ids)
      .orderBy('a.sort_order')
      .execute(),
    db
      .selectFrom('video_items as vi')
      .innerJoin('items as i', 'i.id', 'vi.item_id')
      .select(['vi.video_id', 'i.id', 'i.name', 'vi.suggested'])
      .where('vi.video_id', 'in', ids)
      .orderBy('i.sort_order')
      .execute(),
    db
      .selectFrom('video_house_areas as vh')
      .innerJoin('house_areas as h', 'h.id', 'vh.house_area_id')
      .select(['vh.video_id', 'h.id', 'h.name'])
      .where('vh.video_id', 'in', ids)
      .orderBy('h.sort_order')
      .execute(),
  ]);
  const toLinks = (rows: { id: number; name: string; suggested: number }[] = []): Link[] =>
    rows.map((r) => ({ id: r.id, name: r.name, suggested: r.suggested === 1 }));
  const tagMap = groupBy(tags);
  const areaMap = groupBy(areas);
  const itemMap = groupBy(items);
  const houseAreaMap = groupBy(houseAreas);

  return videos.map((v) => ({
    id: v.id,
    youtubeId: v.youtube_id,
    houseId: v.house_id,
    title: v.title,
    channelName: v.channel_name,
    thumbnailUrl: v.thumbnail_url,
    source: v.source,
    metadataStatus: v.metadata_status,
    reviewStatus: v.review_status,
    createdAt: v.created_at,
    tags: toLinks(tagMap.get(v.id)),
    areaTypes: toLinks(areaMap.get(v.id)),
    items: toLinks(itemMap.get(v.id)),
    houseAreas: (houseAreaMap.get(v.id) ?? []).map((h) => ({ id: h.id, name: h.name })),
  }));
}
