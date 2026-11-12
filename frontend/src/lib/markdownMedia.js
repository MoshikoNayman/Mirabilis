// @ts-check
// Which images assistant markdown may load. Model text can carry a remote image
// whose URL holds chat data (from a prompt-injected page, feed or tool result);
// loading it would send that data off the machine with no click, past Go Dark.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** @param {string} value @returns {URL|null} */
function parse(value) {
  try { return new URL(value); } catch { return null; }
}

/**
 * True when an image source stays on this machine: inline data, a blob, a path
 * on the app's own origin, the backend, or a loopback host.
 * @param {unknown} src
 * @param {string[]} [origins] origins that count as local, such as the page and the backend
 * @returns {boolean}
 */
export function isLocalImageSrc(src, origins = []) {
  if (typeof src !== 'string') return false;
  const value = src.trim();
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;
  if (/^blob:/i.test(value)) return true;
  // No scheme and not protocol-relative: a path on the page's own origin.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith('//') && !value.startsWith('\\')) return true;
  const url = parse(value.startsWith('//') ? `http:${value}` : value);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
  if (LOOPBACK.has(url.hostname)) return true;
  return origins.some((origin) => parse(origin)?.origin === url.origin);
}

/**
 * The link that stands in for a remote image: its http(s) URL and a label.
 * @param {unknown} src
 * @param {unknown} alt
 * @returns {{ href: string|null, label: string }}
 */
export function remoteImageLink(src, alt) {
  const url = typeof src === 'string' ? parse(src.trim()) : null;
  const web = url && (url.protocol === 'http:' || url.protocol === 'https:') ? url : null;
  const name = typeof alt === 'string' && alt.trim() ? alt.trim() : 'Image';
  return { href: web ? web.href : null, label: web ? `${name} (${web.hostname})` : name };
}
