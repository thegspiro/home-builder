/**
 * Slots in the 3D house where a house area can be drawn (docs/PLAN.md section 7).
 * Area types in the "system" category use the special "overlay" zone instead: they are
 * shown as toggleable overlays, never as rooms, so they cannot be house areas.
 */
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

export type HouseZone = (typeof HOUSE_ZONES)[number];

export const OVERLAY_ZONE = 'overlay';

export function isHouseZone(zone: string): zone is HouseZone {
  return (HOUSE_ZONES as readonly string[]).includes(zone);
}
