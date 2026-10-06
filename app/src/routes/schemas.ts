/** JSON Schema fragments shared by route definitions. */
export const ID = { type: 'integer', minimum: 1, maximum: 4294967295 } as const;
export const ID_LIST = { type: 'array', items: ID, maxItems: 500, uniqueItems: true } as const;
