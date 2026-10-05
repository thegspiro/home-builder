import { describe, expect, it } from 'vitest';
import { parsePlaylistId } from '../../src/youtube.js';

const ID = 'PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG';

describe('parsePlaylistId', () => {
  it.each([
    ID,
    `  ${ID} `,
    `https://www.youtube.com/playlist?list=${ID}`,
    `https://youtube.com/playlist?list=${ID}&si=abc`,
    `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${ID}&index=2`,
    `m.youtube.com/playlist?list=${ID}`,
    `https://music.youtube.com/playlist?list=${ID}`,
  ])('accepts %s', (input) => {
    expect(parsePlaylistId(input)).toBe(ID);
  });

  it.each([
    '',
    'short',
    'has spaces in it',
    `https://example.com/playlist?list=${ID}`,
    `https://youtube.com.evil.example/playlist?list=${ID}`,
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/playlist?list=bad%20id!',
    `javascript:alert(1)?list=${ID}`,
    `ftp://youtube.com/playlist?list=${ID}`,
  ])('rejects %s', (input) => {
    expect(parsePlaylistId(input)).toBeNull();
  });
});
