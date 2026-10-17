/**
 * Whether `value` is lower-case kebab: `-`-separated runs of `a-z0-9`. Split-based rather than a
 * single nested-quantifier pattern, so it is linear by construction.
 */
export function isKebab(value: string): boolean {
  return value.split('-').every((part) => /^[a-z0-9]+$/.test(part));
}
