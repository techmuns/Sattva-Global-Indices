/** Tiny DOM helpers. No framework, no dependencies. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/**
 * Create an element.
 * `attrs.class`, `attrs.dataset`, `on*` handlers and plain attributes are supported.
 * Children may be nodes or strings; strings are inserted as TEXT, never parsed.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of [children].flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function empty(node) {
  if (node) while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/**
 * Escape a value for interpolation into an HTML string.
 *
 * Everything in this app that builds markup as a string routes user- and
 * data-derived text through here. The data is our own generated JSON rather
 * than user input, but company names legitimately contain `&` (ARE&M, M&M) and
 * quotes, and those break attributes and text nodes just as effectively as an
 * attack would.
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Run on the next idle slice, with a timeout so a backgrounded tab still finishes. */
export function onIdle(fn, timeout = 200) {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(fn, { timeout });
  return setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 16);
}
