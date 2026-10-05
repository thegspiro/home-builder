/**
 * Initial schema. See docs/PLAN.md section 5.
 *
 * Notes on MySQL constraints that shape this file:
 * - `videos.house_scope` and `tags.house_scope` are STORED generated columns
 *   (COALESCE(house_id, 0)) so a UNIQUE index treats "shared" (NULL house) as a
 *   single scope. MySQL forbids CASCADE / SET NULL on a foreign key whose column
 *   is the base of a stored generated column, so those two foreign keys are
 *   RESTRICT: deleting a house must delete its private videos and tags first.
 * - `house_item_placements` uses a composite foreign key to `house_areas(id, house_id)`
 *   so an item can only be placed in an area that belongs to the same house.
 * - MySQL DDL is not transactional, so every CREATE uses IF NOT EXISTS: if a run
 *   is interrupted part-way, the next start re-runs this migration safely.
 */
import { sql, type Kysely } from 'kysely';

const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci';

const UP: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS area_types (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    slug VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    category ENUM('interior','exterior','system','workshop') NOT NULL,
    default_zone VARCHAR(32) NOT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_area_types_slug (slug)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS items (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    slug VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    system_area_type_id INT UNSIGNED NULL,
    whole_house BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_items_slug (slug),
    CONSTRAINT fk_items_system_area_type FOREIGN KEY (system_area_type_id)
      REFERENCES area_types (id) ON DELETE SET NULL
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS item_default_placements (
    item_id INT UNSIGNED NOT NULL,
    area_type_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (item_id, area_type_id),
    CONSTRAINT fk_idp_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
    CONSTRAINT fk_idp_area_type FOREIGN KEY (area_type_id)
      REFERENCES area_types (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS houses (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(128) NOT NULL,
    created_by VARCHAR(320) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS house_members (
    house_id INT UNSIGNED NOT NULL,
    email VARCHAR(320) NOT NULL,
    role ENUM('owner','editor','viewer') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (house_id, email),
    KEY ix_house_members_email (email),
    CONSTRAINT fk_house_members_house FOREIGN KEY (house_id)
      REFERENCES houses (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS house_areas (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    house_id INT UNSIGNED NOT NULL,
    area_type_id INT UNSIGNED NULL,
    name VARCHAR(128) NOT NULL,
    zone VARCHAR(32) NOT NULL,
    hidden BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_house_areas_id_house (id, house_id),
    KEY ix_house_areas_house (house_id, sort_order),
    CONSTRAINT fk_house_areas_house FOREIGN KEY (house_id)
      REFERENCES houses (id) ON DELETE CASCADE,
    CONSTRAINT fk_house_areas_area_type FOREIGN KEY (area_type_id)
      REFERENCES area_types (id) ON DELETE SET NULL
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS house_item_placements (
    house_id INT UNSIGNED NOT NULL,
    item_id INT UNSIGNED NOT NULL,
    house_area_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (house_id, item_id, house_area_id),
    KEY ix_hip_area (house_area_id, house_id),
    CONSTRAINT fk_hip_house FOREIGN KEY (house_id) REFERENCES houses (id) ON DELETE CASCADE,
    CONSTRAINT fk_hip_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
    CONSTRAINT fk_hip_area_same_house FOREIGN KEY (house_area_id, house_id)
      REFERENCES house_areas (id, house_id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS house_hidden_items (
    house_id INT UNSIGNED NOT NULL,
    item_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (house_id, item_id),
    CONSTRAINT fk_hhi_house FOREIGN KEY (house_id) REFERENCES houses (id) ON DELETE CASCADE,
    CONSTRAINT fk_hhi_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS videos (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    youtube_id CHAR(11) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    house_id INT UNSIGNED NULL,
    house_scope INT UNSIGNED AS (COALESCE(house_id, 0)) STORED NOT NULL,
    title VARCHAR(500) NULL,
    channel_name VARCHAR(255) NULL,
    thumbnail_url VARCHAR(2048) NULL,
    notes TEXT NULL,
    source ENUM('playlist','csv','paste','manual') NOT NULL,
    review_status ENUM('inbox','sorted') NOT NULL DEFAULT 'inbox',
    metadata_status ENUM('pending','ok','unavailable') NOT NULL DEFAULT 'pending',
    added_by VARCHAR(320) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_videos_youtube_scope (youtube_id, house_scope),
    KEY ix_videos_house (house_id),
    KEY ix_videos_review (review_status, created_at),
    FULLTEXT KEY ft_videos_text (title, channel_name, notes),
    CONSTRAINT chk_videos_youtube_id CHECK (REGEXP_LIKE(youtube_id, '^[A-Za-z0-9_-]{11}$', 'c')),
    CONSTRAINT fk_videos_house FOREIGN KEY (house_id) REFERENCES houses (id) ON DELETE RESTRICT
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS tags (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    house_id INT UNSIGNED NULL,
    house_scope INT UNSIGNED AS (COALESCE(house_id, 0)) STORED NOT NULL,
    slug VARCHAR(64) NOT NULL,
    name VARCHAR(128) NOT NULL,
    kind ENUM('task','skill','topic','trade','tools','other') NOT NULL DEFAULT 'other',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_tags_slug_scope (slug, house_scope),
    KEY ix_tags_house (house_id),
    CONSTRAINT fk_tags_house FOREIGN KEY (house_id) REFERENCES houses (id) ON DELETE RESTRICT
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS video_tags (
    video_id INT UNSIGNED NOT NULL,
    tag_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (video_id, tag_id),
    KEY ix_video_tags_tag (tag_id),
    CONSTRAINT fk_video_tags_video FOREIGN KEY (video_id) REFERENCES videos (id) ON DELETE CASCADE,
    CONSTRAINT fk_video_tags_tag FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS video_area_types (
    video_id INT UNSIGNED NOT NULL,
    area_type_id INT UNSIGNED NOT NULL,
    suggested BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (video_id, area_type_id),
    KEY ix_vat_area_type (area_type_id),
    CONSTRAINT fk_vat_video FOREIGN KEY (video_id) REFERENCES videos (id) ON DELETE CASCADE,
    CONSTRAINT fk_vat_area_type FOREIGN KEY (area_type_id)
      REFERENCES area_types (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS video_items (
    video_id INT UNSIGNED NOT NULL,
    item_id INT UNSIGNED NOT NULL,
    suggested BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (video_id, item_id),
    KEY ix_video_items_item (item_id),
    CONSTRAINT fk_video_items_video FOREIGN KEY (video_id) REFERENCES videos (id) ON DELETE CASCADE,
    CONSTRAINT fk_video_items_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS video_house_areas (
    video_id INT UNSIGNED NOT NULL,
    house_area_id INT UNSIGNED NOT NULL,
    PRIMARY KEY (video_id, house_area_id),
    KEY ix_vha_area (house_area_id),
    CONSTRAINT fk_vha_video FOREIGN KEY (video_id) REFERENCES videos (id) ON DELETE CASCADE,
    CONSTRAINT fk_vha_area FOREIGN KEY (house_area_id)
      REFERENCES house_areas (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS keyword_rules (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    phrase VARCHAR(200) NOT NULL,
    tag_id INT UNSIGNED NULL,
    area_type_id INT UNSIGNED NULL,
    item_id INT UNSIGNED NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_rules_tag FOREIGN KEY (tag_id) REFERENCES tags (id) ON DELETE CASCADE,
    CONSTRAINT fk_rules_area_type FOREIGN KEY (area_type_id)
      REFERENCES area_types (id) ON DELETE CASCADE,
    CONSTRAINT fk_rules_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS playlists (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    youtube_playlist_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    title VARCHAR(500) NULL,
    last_synced_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_playlists_youtube_id (youtube_playlist_id)
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS import_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    type ENUM('playlist_sync','csv_import','paste_import','metadata_refresh') NOT NULL,
    house_id INT UNSIGNED NULL,
    payload JSON NOT NULL,
    status ENUM('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
    result JSON NULL,
    error TEXT NULL,
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    created_by VARCHAR(320) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL,
    finished_at TIMESTAMP NULL,
    PRIMARY KEY (id),
    KEY ix_import_jobs_status (status, created_at),
    CONSTRAINT fk_import_jobs_house FOREIGN KEY (house_id) REFERENCES houses (id) ON DELETE CASCADE
  ) ${TABLE_OPTIONS}`,

  `CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    actor_email VARCHAR(320) NOT NULL,
    house_id INT UNSIGNED NULL,
    action VARCHAR(64) NOT NULL,
    entity VARCHAR(64) NOT NULL,
    entity_id VARCHAR(64) NULL,
    details JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_audit_log_house (house_id, created_at),
    KEY ix_audit_log_actor (actor_email, created_at)
  ) ${TABLE_OPTIONS}`,
];

// Reverse dependency order.
const DOWN_TABLES: readonly string[] = [
  'audit_log',
  'import_jobs',
  'playlists',
  'keyword_rules',
  'video_house_areas',
  'video_items',
  'video_area_types',
  'video_tags',
  'tags',
  'videos',
  'house_hidden_items',
  'house_item_placements',
  'house_areas',
  'house_members',
  'houses',
  'item_default_placements',
  'items',
  'area_types',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of UP) {
    await sql.raw(statement).execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of DOWN_TABLES) {
    await sql`DROP TABLE IF EXISTS ${sql.table(table)}`.execute(db);
  }
}
