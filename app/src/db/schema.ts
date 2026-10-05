/**
 * Kysely table types. Must match the migrations in src/db/migrations.
 * See docs/PLAN.md section 5 for the meaning of each table.
 */
import type { ColumnType, Generated } from 'kysely';

type CreatedAt = ColumnType<Date, never, never>;
type UpdatedAt = ColumnType<Date, never, never>;
/** MySQL BOOLEAN is TINYINT(1); mysql2 returns it as a number. */
type Bool = ColumnType<number, boolean | number | undefined, boolean | number>;
type Json = ColumnType<unknown, string | undefined, string>;
/** Column with a database default: optional on insert. */
type Defaulted<T> = ColumnType<T, T | undefined, T>;

export type AreaCategory = 'interior' | 'exterior' | 'system' | 'workshop';
export type HouseRole = 'owner' | 'editor' | 'viewer';
export type TagKind = 'task' | 'skill' | 'topic' | 'trade' | 'tools' | 'other';
export type VideoSource = 'playlist' | 'csv' | 'paste' | 'manual';
export type ReviewStatus = 'inbox' | 'sorted';
export type MetadataStatus = 'pending' | 'ok' | 'unavailable';
export type JobType = 'playlist_sync' | 'csv_import' | 'paste_import' | 'metadata_refresh';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface AreaTypesTable {
  id: Generated<number>;
  slug: string;
  name: string;
  category: AreaCategory;
  default_zone: string;
  sort_order: Defaulted<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ItemsTable {
  id: Generated<number>;
  slug: string;
  name: string;
  system_area_type_id: number | null;
  whole_house: Bool;
  sort_order: Defaulted<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface ItemDefaultPlacementsTable {
  item_id: number;
  area_type_id: number;
}

export interface HousesTable {
  id: Generated<number>;
  name: string;
  created_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface HouseMembersTable {
  house_id: number;
  email: string;
  role: HouseRole;
  created_at: CreatedAt;
}

export interface HouseAreasTable {
  id: Generated<number>;
  house_id: number;
  area_type_id: number | null;
  name: string;
  zone: string;
  hidden: Bool;
  sort_order: Defaulted<number>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface HouseItemPlacementsTable {
  house_id: number;
  item_id: number;
  house_area_id: number;
}

export interface HouseHiddenItemsTable {
  house_id: number;
  item_id: number;
}

export interface VideosTable {
  id: Generated<number>;
  youtube_id: string;
  house_id: number | null;
  /** Stored generated column: COALESCE(house_id, 0). */
  house_scope: ColumnType<number, never, never>;
  title: string | null;
  channel_name: string | null;
  thumbnail_url: string | null;
  notes: string | null;
  source: VideoSource;
  review_status: Defaulted<ReviewStatus>;
  metadata_status: Defaulted<MetadataStatus>;
  added_by: string;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

export interface TagsTable {
  id: Generated<number>;
  house_id: number | null;
  house_scope: ColumnType<number, never, never>;
  slug: string;
  name: string;
  kind: Defaulted<TagKind>;
  created_at: CreatedAt;
}

export interface VideoTagsTable {
  video_id: number;
  tag_id: number;
}

export interface VideoAreaTypesTable {
  video_id: number;
  area_type_id: number;
  suggested: Bool;
}

export interface VideoItemsTable {
  video_id: number;
  item_id: number;
  suggested: Bool;
}

export interface VideoHouseAreasTable {
  video_id: number;
  house_area_id: number;
}

export interface KeywordRulesTable {
  id: Generated<number>;
  phrase: string;
  tag_id: number | null;
  area_type_id: number | null;
  item_id: number | null;
  enabled: Bool;
  created_at: CreatedAt;
}

export interface PlaylistsTable {
  id: Generated<number>;
  youtube_playlist_id: string;
  title: string | null;
  last_synced_at: Defaulted<Date | null>;
  created_at: CreatedAt;
}

export interface ImportJobsTable {
  id: Generated<number>;
  type: JobType;
  house_id: number | null;
  payload: Json;
  status: Defaulted<JobStatus>;
  result: Json | null;
  error: string | null;
  attempts: Defaulted<number>;
  created_by: string;
  created_at: CreatedAt;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface AuditLogTable {
  id: Generated<number>;
  actor_email: string;
  house_id: number | null;
  action: string;
  entity: string;
  entity_id: string | null;
  details: Json | null;
  created_at: CreatedAt;
}

export interface Database {
  area_types: AreaTypesTable;
  items: ItemsTable;
  item_default_placements: ItemDefaultPlacementsTable;
  houses: HousesTable;
  house_members: HouseMembersTable;
  house_areas: HouseAreasTable;
  house_item_placements: HouseItemPlacementsTable;
  house_hidden_items: HouseHiddenItemsTable;
  videos: VideosTable;
  tags: TagsTable;
  video_tags: VideoTagsTable;
  video_area_types: VideoAreaTypesTable;
  video_items: VideoItemsTable;
  video_house_areas: VideoHouseAreasTable;
  keyword_rules: KeywordRulesTable;
  playlists: PlaylistsTable;
  import_jobs: ImportJobsTable;
  audit_log: AuditLogTable;
}
