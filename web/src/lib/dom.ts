/**
 * Tiny DOM builder. Text is always set with textContent and attributes with
 * setAttribute, so data from the API (video titles, names…) can never become markup.
 */
export type Child = Node | string | number | null | undefined | false;

export interface Attrs {
  class?: string;
  /** Event listeners, e.g. { click: handler }. */
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
  [attribute: string]: unknown;
}

const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction']);

/** Only http(s) and same-site relative URLs may be used in links and media. */
export function isSafeUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'on') {
      for (const [event, handler] of Object.entries(value as Record<string, EventListener>)) {
        el.addEventListener(event, handler);
      }
    } else if (value === true) {
      el.setAttribute(name, '');
    } else if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value);
      if (URL_ATTRIBUTES.has(name) && !isSafeUrl(text)) continue;
      el.setAttribute(name, text);
    }
  }
  append(el, ...children);
  return el;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, ...children);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}
