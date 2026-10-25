const ENTITY_PREFIXES = ['/cases/', '/projects/', '/engagements/', '/meetings/'] as const;

/**
 * True when `path` is an entity page whose visit counts as having seen its notifications:
 * a known prefix followed by exactly one non-empty segment (`/cases/:id`). Hub paths
 * (`/projects`, `/experts`, `/settings/billing`) and sub-pages (`/projects/p1/files`,
 * `/meetings/m1/call`) are not entity pages.
 */
export function isAutoReadablePath(path: string): boolean {
  const prefix = ENTITY_PREFIXES.find((candidate) => path.startsWith(candidate));
  if (prefix === undefined) {
    return false;
  }
  const rest = path.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}
