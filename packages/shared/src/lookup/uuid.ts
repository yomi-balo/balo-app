/**
 * `isLookupUuid` — the ONE "is this a full canonical uuid" predicate for the BAL-551 admin
 * Lookup surface (fix round F9). Before this hoist, `@balo/db`'s `platform-lookup.ts` and
 * `apps/web`'s `_lib/lookup-view.ts` each carried their own independently-written version —
 * REV-4 verified the two agreed on every reachable input, so this hoist is a consolidation,
 * not a behaviour change. Both callers now import this one.
 *
 * True only for a FULL canonical uuid: 8-4-4-4-12 hex groups, hyphens at exactly those four
 * positions, hex everywhere else. Case-insensitive — `@balo/db`'s caller passes an
 * already-lowercased string (`normalizeLookupQuery`), while the analytics-only classifier in
 * `lookup-view.ts` passes the raw, unnormalised query, so this must accept either case rather
 * than assuming the caller folded it first.
 *
 * NO REGEX — this repo's ReDoS-avoidance convention on a per-keystroke scan path (memory
 * `reference_sonarcloud_redos_tagstrip_regex`) — a fixed-length character walk instead.
 */
const HEX_CHARS = '0123456789abcdefABCDEF';

export function isLookupUuid(value: string): boolean {
  if (value.length !== 36) return false;
  for (let index = 0; index < value.length; index++) {
    const char = value.charAt(index);
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (char !== '-') return false;
    } else if (!HEX_CHARS.includes(char)) {
      return false;
    }
  }
  return true;
}
