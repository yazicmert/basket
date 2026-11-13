/**
 * Separator-neutral path keys.
 *
 * Folder grouping and path-context rules are written for '/'-separated absolute paths. A
 * Windows path is turned into that shape for matching only ("C:\Users\me" -> "/C:/Users/me"),
 * so one set of rules serves every platform and files on several drives still share a root.
 * A key is never passed to the filesystem; `fromPathKey` gives the real path back for display.
 */

const WINDOWS_PATH = /^[A-Za-z]:([\\/]|$)|^\\\\/;

export function toPathKey(filePath) {
  const value = String(filePath || '');
  if (!WINDOWS_PATH.test(value)) {
    return value;
  }
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return slashed.startsWith('/') ? slashed : `/${slashed}`;
}

export function fromPathKey(key) {
  const value = String(key || '');
  if (/^\/[A-Za-z]:(\/|$)/.test(value)) {
    const real = value.slice(1).replace(/\//g, '\\');
    return real.length === 2 ? `${real}\\` : real;
  }
  if (/^\/\/[^/]/.test(value)) {
    return value.replace(/\//g, '\\');
  }
  return value;
}
