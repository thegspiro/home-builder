import { describe, expect, it } from 'vitest';
import { slugify } from '../../src/routes/library.js';
import { parseQuery } from '../../src/videos/search.js';

describe('parseQuery', () => {
  it('requires every word, with prefix matching', () => {
    expect(parseQuery('Garage door')).toEqual({ fullText: '+garage* +door*', shortWords: [] });
  });

  it('drops boolean-mode operators and punctuation', () => {
    expect(parseQuery('-roof +"leak" (gutter)* ~x <y> @3')).toEqual({
      fullText: '+roof* +leak* +gutter*',
      shortWords: ['x', 'y', '3'],
    });
  });

  it('routes short words to whole-word matching and drops stopwords', () => {
    expect(parseQuery('how to fix the AC unit')).toEqual({
      fullText: '+fix* +unit*',
      shortWords: ['ac'],
    });
  });

  it('dedupes, caps at 10 words, and handles empty input', () => {
    expect(parseQuery('roof roof ROOF')).toEqual({ fullText: '+roof*', shortWords: [] });
    const many = Array.from({ length: 15 }, (_, i) => `word${i}`).join(' ');
    expect(parseQuery(many).fullText.split(' ')).toHaveLength(10);
    expect(parseQuery(undefined)).toEqual({ fullText: '', shortWords: [] });
    expect(parseQuery('  !!! ')).toEqual({ fullText: '', shortWords: [] });
  });

  it('keeps non-English letters', () => {
    expect(parseQuery('Fenêtre')).toEqual({ fullText: '+fenêtre*', shortWords: [] });
  });
});

describe('slugify', () => {
  it.each([
    ['Code & permits', 'code-permits'],
    ['  Hire a pro  ', 'hire-a-pro'],
    ['Fenêtre réparée', 'fenetre-reparee'],
    ['!!!', ''],
    ['a'.repeat(70), 'a'.repeat(64)],
  ])('%s → %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});
