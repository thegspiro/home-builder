/** Area filter values are "room:<houseAreaId>" (house selected) or "type:<areaTypeId>". */
export function areaParams(value: string): { houseAreaId?: number; areaTypeId?: number } {
  const [kind, raw] = value.split(':');
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return {};
  if (kind === 'room') return { houseAreaId: id };
  if (kind === 'type') return { areaTypeId: id };
  return {};
}
