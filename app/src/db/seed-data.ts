/**
 * Starting catalog: area types, items with default placements, and shared tags.
 * See docs/PLAN.md section 5.3. Applied once by migration 0002; later changes to the
 * catalog ship as new migrations so edits made in the app are never overwritten.
 */
import type { AreaCategory, TagKind } from './schema.js';

export interface AreaTypeSeed {
  slug: string;
  name: string;
  category: AreaCategory;
  /** Slot in the 3D house where areas of this type are drawn. */
  zone: string;
}

export interface ItemSeed {
  slug: string;
  name: string;
  /** Area type slugs this item is placed in when a house is created. */
  defaultAreas: readonly string[];
  /** Whole-house system the item belongs to, if any (an area type slug). */
  system?: string;
  /** Shown in every interior area instead of being placed. */
  wholeHouse?: boolean;
}

export interface TagSeed {
  slug: string;
  name: string;
  kind: TagKind;
}

export const AREA_TYPES: readonly AreaTypeSeed[] = [
  { slug: 'kitchen', name: 'Kitchen', category: 'interior', zone: 'kitchen' },
  { slug: 'bathroom', name: 'Bathroom', category: 'interior', zone: 'bathroom' },
  { slug: 'bedroom', name: 'Bedroom', category: 'interior', zone: 'bedroom' },
  { slug: 'living-room', name: 'Living room', category: 'interior', zone: 'living-room' },
  { slug: 'laundry', name: 'Laundry', category: 'interior', zone: 'laundry' },
  { slug: 'basement', name: 'Basement', category: 'interior', zone: 'basement' },
  { slug: 'attic', name: 'Attic', category: 'interior', zone: 'attic' },
  { slug: 'garage', name: 'Garage', category: 'interior', zone: 'garage' },

  { slug: 'roof-gutters', name: 'Roof & gutters', category: 'exterior', zone: 'roof' },
  { slug: 'siding-windows', name: 'Siding & windows', category: 'exterior', zone: 'walls' },
  { slug: 'exterior-doors', name: 'Exterior doors', category: 'exterior', zone: 'walls' },
  { slug: 'deck-porch', name: 'Deck/porch', category: 'exterior', zone: 'deck' },
  { slug: 'foundation', name: 'Foundation', category: 'exterior', zone: 'foundation' },
  { slug: 'driveway', name: 'Driveway', category: 'exterior', zone: 'driveway' },
  { slug: 'yard', name: 'Yard/landscaping', category: 'exterior', zone: 'yard' },

  { slug: 'electrical', name: 'Electrical', category: 'system', zone: 'overlay' },
  { slug: 'plumbing', name: 'Plumbing', category: 'system', zone: 'overlay' },
  { slug: 'hvac', name: 'HVAC', category: 'system', zone: 'overlay' },
  { slug: 'insulation', name: 'Insulation', category: 'system', zone: 'overlay' },
  { slug: 'framing', name: 'Framing', category: 'system', zone: 'overlay' },
  { slug: 'drywall-paint', name: 'Drywall & paint', category: 'system', zone: 'overlay' },

  { slug: 'tools', name: 'Tools', category: 'workshop', zone: 'shed' },
  { slug: 'safety', name: 'Safety', category: 'workshop', zone: 'shed' },
  { slug: 'general-skills', name: 'General skills', category: 'workshop', zone: 'shed' },
];

export const ITEMS: readonly ItemSeed[] = [
  // Garage
  {
    slug: 'electrical-panel',
    name: 'Electrical panel (main)',
    defaultAreas: ['garage'],
    system: 'electrical',
  },
  { slug: 'garage-door', name: 'Garage door', defaultAreas: ['garage'] },
  {
    slug: 'garage-door-opener',
    name: 'Garage door opener',
    defaultAreas: ['garage'],
    system: 'electrical',
  },
  { slug: 'water-heater', name: 'Water heater', defaultAreas: ['garage'], system: 'plumbing' },
  // Basement
  { slug: 'furnace', name: 'Furnace', defaultAreas: ['basement'], system: 'hvac' },
  { slug: 'sump-pump', name: 'Sump pump', defaultAreas: ['basement'], system: 'plumbing' },
  {
    slug: 'water-main-shutoff',
    name: 'Water main shutoff',
    defaultAreas: ['basement'],
    system: 'plumbing',
  },
  {
    slug: 'water-softener',
    name: 'Water softener',
    defaultAreas: ['basement'],
    system: 'plumbing',
  },
  { slug: 'dehumidifier', name: 'Dehumidifier', defaultAreas: ['basement'], system: 'hvac' },
  {
    slug: 'pressure-tank',
    name: 'Pressure tank (well)',
    defaultAreas: ['basement'],
    system: 'plumbing',
  },
  {
    slug: 'electrical-subpanel',
    name: 'Electrical sub-panel',
    defaultAreas: ['basement'],
    system: 'electrical',
  },
  { slug: 'gas-shutoff', name: 'Gas shutoff', defaultAreas: ['basement'] },
  // Kitchen
  {
    slug: 'kitchen-sink-faucet',
    name: 'Kitchen sink & faucet',
    defaultAreas: ['kitchen'],
    system: 'plumbing',
  },
  {
    slug: 'garbage-disposal',
    name: 'Garbage disposal',
    defaultAreas: ['kitchen'],
    system: 'plumbing',
  },
  { slug: 'dishwasher', name: 'Dishwasher', defaultAreas: ['kitchen'], system: 'plumbing' },
  { slug: 'range-hood', name: 'Range hood', defaultAreas: ['kitchen'], system: 'hvac' },
  {
    slug: 'refrigerator-water-line',
    name: 'Refrigerator water line',
    defaultAreas: ['kitchen'],
    system: 'plumbing',
  },
  { slug: 'cabinets', name: 'Cabinets', defaultAreas: ['kitchen'] },
  { slug: 'countertops', name: 'Countertops', defaultAreas: ['kitchen'] },
  // Bathroom
  { slug: 'toilet', name: 'Toilet', defaultAreas: ['bathroom'], system: 'plumbing' },
  { slug: 'shower-tub', name: 'Shower/tub', defaultAreas: ['bathroom'], system: 'plumbing' },
  {
    slug: 'vanity-faucet',
    name: 'Vanity & faucet',
    defaultAreas: ['bathroom'],
    system: 'plumbing',
  },
  {
    slug: 'bathroom-exhaust-fan',
    name: 'Bathroom exhaust fan',
    defaultAreas: ['bathroom'],
    system: 'hvac',
  },
  { slug: 'gfci-outlets', name: 'GFCI outlets', defaultAreas: ['bathroom'], system: 'electrical' },
  // Laundry
  { slug: 'washer-hookups', name: 'Washer hookups', defaultAreas: ['laundry'], system: 'plumbing' },
  { slug: 'dryer-vent', name: 'Dryer & dryer vent', defaultAreas: ['laundry'], system: 'hvac' },
  // Living room
  { slug: 'fireplace', name: 'Fireplace', defaultAreas: ['living-room'] },
  { slug: 'ceiling-fan', name: 'Ceiling fan', defaultAreas: ['living-room'], system: 'electrical' },
  // Bedroom
  { slug: 'closet', name: 'Closet', defaultAreas: ['bedroom'] },
  { slug: 'window-trim', name: 'Windows (interior trim)', defaultAreas: ['bedroom'] },
  // Attic
  {
    slug: 'attic-insulation',
    name: 'Attic insulation',
    defaultAreas: ['attic'],
    system: 'insulation',
  },
  {
    slug: 'attic-ventilation',
    name: 'Attic fan / ventilation',
    defaultAreas: ['attic'],
    system: 'hvac',
  },
  { slug: 'attic-access', name: 'Attic access', defaultAreas: ['attic'] },
  // Roof & gutters
  { slug: 'shingles', name: 'Shingles', defaultAreas: ['roof-gutters'] },
  { slug: 'flashing', name: 'Flashing', defaultAreas: ['roof-gutters'] },
  { slug: 'gutters-downspouts', name: 'Gutters & downspouts', defaultAreas: ['roof-gutters'] },
  { slug: 'chimney', name: 'Chimney', defaultAreas: ['roof-gutters'] },
  // Siding & windows
  { slug: 'siding', name: 'Siding', defaultAreas: ['siding-windows'] },
  { slug: 'exterior-windows', name: 'Exterior windows', defaultAreas: ['siding-windows'] },
  {
    slug: 'caulking-weatherstripping',
    name: 'Caulking & weatherstripping',
    defaultAreas: ['siding-windows'],
    system: 'insulation',
  },
  // Exterior doors
  { slug: 'entry-door', name: 'Entry door', defaultAreas: ['exterior-doors'] },
  { slug: 'patio-door', name: 'Sliding/patio door', defaultAreas: ['exterior-doors'] },
  { slug: 'storm-door', name: 'Storm door', defaultAreas: ['exterior-doors'] },
  // Deck/porch
  { slug: 'deck-boards', name: 'Deck boards', defaultAreas: ['deck-porch'] },
  { slug: 'railings', name: 'Railings', defaultAreas: ['deck-porch'] },
  // Foundation
  { slug: 'foundation-walls', name: 'Foundation walls', defaultAreas: ['foundation'] },
  { slug: 'crawlspace', name: 'Crawlspace', defaultAreas: ['foundation'] },
  { slug: 'grading-drainage', name: 'Grading & drainage', defaultAreas: ['foundation'] },
  // Driveway
  { slug: 'driveway-surface', name: 'Driveway', defaultAreas: ['driveway'] },
  { slug: 'walkways', name: 'Walkways', defaultAreas: ['driveway'] },
  // Yard/landscaping
  { slug: 'hose-bibs', name: 'Hose bibs', defaultAreas: ['yard'], system: 'plumbing' },
  { slug: 'irrigation', name: 'Irrigation', defaultAreas: ['yard'], system: 'plumbing' },
  { slug: 'well-pump', name: 'Well pump', defaultAreas: ['yard'], system: 'plumbing' },
  { slug: 'septic-tank', name: 'Septic tank', defaultAreas: ['yard'], system: 'plumbing' },
  { slug: 'fence', name: 'Fence', defaultAreas: ['yard'] },
  {
    slug: 'ac-condenser-heat-pump',
    name: 'AC condenser / heat pump',
    defaultAreas: ['yard'],
    system: 'hvac',
  },
  { slug: 'electric-meter', name: 'Electric meter', defaultAreas: ['yard'], system: 'electrical' },
  { slug: 'gas-meter', name: 'Gas meter', defaultAreas: ['yard'] },
  // Whole house: shown in every interior area
  { slug: 'thermostat', name: 'Thermostat', defaultAreas: [], system: 'hvac', wholeHouse: true },
  {
    slug: 'smoke-co-detectors',
    name: 'Smoke & CO detectors',
    defaultAreas: [],
    system: 'electrical',
    wholeHouse: true,
  },
  {
    slug: 'outlets-switches',
    name: 'Outlets & switches',
    defaultAreas: [],
    system: 'electrical',
    wholeHouse: true,
  },
  {
    slug: 'light-fixtures',
    name: 'Light fixtures',
    defaultAreas: [],
    system: 'electrical',
    wholeHouse: true,
  },
  {
    slug: 'interior-doors',
    name: 'Interior doors',
    defaultAreas: [],
    system: 'framing',
    wholeHouse: true,
  },
  { slug: 'flooring', name: 'Flooring', defaultAreas: [], wholeHouse: true },
  { slug: 'drywall', name: 'Drywall', defaultAreas: [], system: 'drywall-paint', wholeHouse: true },
];

export const TAGS: readonly TagSeed[] = [
  { slug: 'install', name: 'Install', kind: 'task' },
  { slug: 'repair', name: 'Repair', kind: 'task' },
  { slug: 'replace', name: 'Replace', kind: 'task' },
  { slug: 'maintenance', name: 'Maintenance', kind: 'task' },
  { slug: 'inspection', name: 'Inspection', kind: 'task' },
  { slug: 'troubleshooting', name: 'Troubleshooting', kind: 'task' },
  { slug: 'upgrade', name: 'Upgrade', kind: 'task' },
  { slug: 'renovation', name: 'Renovation', kind: 'task' },
  { slug: 'new-construction', name: 'New construction', kind: 'task' },
  { slug: 'seasonal', name: 'Seasonal', kind: 'task' },

  { slug: 'beginner', name: 'Beginner', kind: 'skill' },
  { slug: 'intermediate', name: 'Intermediate', kind: 'skill' },
  { slug: 'advanced', name: 'Advanced', kind: 'skill' },
  { slug: 'hire-a-pro', name: 'Hire a pro', kind: 'skill' },

  { slug: 'safety', name: 'Safety', kind: 'topic' },
  { slug: 'code-permits', name: 'Code & permits', kind: 'topic' },
  { slug: 'energy-efficiency', name: 'Energy efficiency', kind: 'topic' },
  { slug: 'cost-saving', name: 'Cost saving', kind: 'topic' },
  { slug: 'water-damage', name: 'Water damage', kind: 'topic' },
  { slug: 'mold', name: 'Mold', kind: 'topic' },
  { slug: 'pests', name: 'Pests', kind: 'topic' },
  { slug: 'weatherproofing', name: 'Weatherproofing', kind: 'topic' },
  { slug: 'storm-prep', name: 'Storm prep', kind: 'topic' },

  { slug: 'carpentry', name: 'Carpentry', kind: 'trade' },
  { slug: 'painting', name: 'Painting', kind: 'trade' },
  { slug: 'tiling', name: 'Tiling', kind: 'trade' },
  { slug: 'flooring', name: 'Flooring', kind: 'trade' },
  { slug: 'concrete', name: 'Concrete', kind: 'trade' },
  { slug: 'roofing', name: 'Roofing', kind: 'trade' },
  { slug: 'plumbing', name: 'Plumbing', kind: 'trade' },
  { slug: 'electrical', name: 'Electrical', kind: 'trade' },
  { slug: 'hvac', name: 'HVAC', kind: 'trade' },
  { slug: 'drywall', name: 'Drywall', kind: 'trade' },
  { slug: 'landscaping', name: 'Landscaping', kind: 'trade' },
  { slug: 'welding', name: 'Welding', kind: 'trade' },

  { slug: 'hand-tools', name: 'Hand tools', kind: 'tools' },
  { slug: 'power-tools', name: 'Power tools', kind: 'tools' },
  { slug: 'measuring', name: 'Measuring', kind: 'tools' },
  { slug: 'tool-maintenance', name: 'Tool maintenance', kind: 'tools' },
];
