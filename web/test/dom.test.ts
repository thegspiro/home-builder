import { describe, expect, it } from 'vitest';
import { h, isSafeUrl, replaceChildren } from '../src/lib/dom';

describe('h()', () => {
  it('inserts text as text, never as markup', () => {
    const el = h('p', {}, '<img src=x onerror="alert(1)">', 42);
    expect(el.textContent).toBe('<img src=x onerror="alert(1)">42');
    expect(el.querySelector('img')).toBeNull();
  });

  it('sets attributes and boolean attributes', () => {
    const el = h('input', { type: 'checkbox', checked: true, disabled: false, 'data-x': 'y' });
    expect(el.getAttribute('type')).toBe('checkbox');
    expect(el.hasAttribute('checked')).toBe(true);
    expect(el.hasAttribute('disabled')).toBe(false);
    expect(el.dataset['x']).toBe('y');
  });

  it('drops javascript: and data: URLs from links and media', () => {
    expect(h('a', { href: 'javascript:alert(1)' }).hasAttribute('href')).toBe(false);
    expect(h('img', { src: 'data:image/png;base64,xx' }).hasAttribute('src')).toBe(false);
    expect(h('a', { href: 'https://www.youtube.com/watch?v=x' }).getAttribute('href')).toBe(
      'https://www.youtube.com/watch?v=x',
    );
    expect(h('a', { href: '/list.html' }).getAttribute('href')).toBe('/list.html');
  });

  it('attaches event listeners', () => {
    let clicks = 0;
    const button = h('button', { on: { click: () => (clicks += 1) } }, 'Go');
    button.click();
    expect(clicks).toBe(1);
  });

  it('skips empty children and replaces content', () => {
    const el = h('div', {}, null, undefined, false, 'a');
    replaceChildren(el, 'b', h('span', {}, 'c'));
    expect(el.textContent).toBe('bc');
  });
});

describe('isSafeUrl', () => {
  it.each([
    ['https://i.ytimg.com/vi/x/hqdefault.jpg', true],
    ['/admin.html', true],
    ['javascript:alert(1)', false],
    ['  javascript:alert(1)', false],
    ['vbscript:x', false],
    ['data:text/html,<script>', false],
  ])('%s → %s', (url, safe) => {
    expect(isSafeUrl(url)).toBe(safe);
  });
});
