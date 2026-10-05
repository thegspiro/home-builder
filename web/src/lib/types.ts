/** Shapes returned by the API (see app/src/routes). */
export type HouseRole = 'owner' | 'editor' | 'viewer';
export type TagKind = 'task' | 'skill' | 'topic' | 'trade' | 'tools' | 'other';

export interface Me {
  email: string;
  isAdmin: boolean;
  houses: { id: number; name: string; role: HouseRole }[];
}

export interface HouseSummary {
  id: number;
  name: string;
  role: HouseRole | null;
}

export interface Link {
  id: number;
  name: string;
  suggested: boolean;
}

export interface Video {
  id: number;
  youtubeId: string;
  houseId: number | null;
  title: string | null;
  channelName: string | null;
  thumbnailUrl: string | null;
  source: string;
  metadataStatus: 'pending' | 'ok' | 'unavailable';
  reviewStatus: 'inbox' | 'sorted';
  createdAt: string;
  tags: Link[];
  areaTypes: Link[];
  items: Link[];
  houseAreas: { id: number; name: string }[];
}

export interface VideoPage {
  total: number;
  videos: Video[];
}

export interface Catalog {
  areaTypes: { id: number; slug: string; name: string; category: string; zone: string }[];
  items: { id: number; slug: string; name: string; system: string | null; wholeHouse: boolean }[];
  tags: { id: number; slug: string; name: string; kind: TagKind; houseId: number | null }[];
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
  areaIds: number[];
}

export interface HouseDetail extends HouseSummary {
  areas: HouseArea[];
  items: HouseItem[];
}

export interface Job {
  id: number;
  type: string;
  houseId: number | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface Playlist {
  id: number;
  youtubePlaylistId: string;
  title: string | null;
  lastSyncedAt: string | null;
}

export interface KeywordRule {
  id: number;
  phrase: string;
  enabled: boolean;
  target: { kind: 'tag' | 'areaType' | 'item'; id: number; name: string };
}

export const HOUSE_ZONES = [
  'kitchen',
  'bathroom',
  'bedroom',
  'living-room',
  'laundry',
  'basement',
  'attic',
  'garage',
  'roof',
  'walls',
  'deck',
  'foundation',
  'driveway',
  'yard',
  'shed',
] as const;
