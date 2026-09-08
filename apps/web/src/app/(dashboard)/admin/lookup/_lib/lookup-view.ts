import {
  User,
  UserCog,
  Building2,
  Users,
  Briefcase,
  CircleDollarSign,
  type LucideIcon,
} from 'lucide-react';
import {
  isLookupUuid,
  LOOKUP_TYPE_FILTERS,
  type LookupEntityType,
  type LookupResult,
  type LookupTypeFilter,
} from '@balo/shared/lookup';
import type { AdminLookupMatchedBy } from '@/lib/analytics';

/**
 * BAL-551 — client-safe view helpers for the Lookup surface: labels, icons, the chip
 * vocabulary, the Open-link policy, and the result-set helpers the shell/chips/list read.
 *
 * ⚠ NO `server-only`, NO value import from `@balo/db` (memory
 * `reference_balo_db_client_bundle_footgun`) — every client component in this route imports
 * from here, so a `@balo/db` value import would drag the postgres driver into the browser
 * bundle.
 */

/** Line-1 label per entity type, matching the copy the drill-in eyebrow renders. */
export const LOOKUP_TYPE_LABEL: Record<LookupEntityType, string> = {
  user: 'User',
  expert: 'Expert',
  company: 'Company',
  agency: 'Agency',
  project_request: 'Project request',
  credit_session: 'Credit session',
};

/** The row-tile icon per entity type. */
export const LOOKUP_TYPE_ICON: Record<LookupEntityType, LucideIcon> = {
  user: User,
  expert: UserCog,
  company: Building2,
  agency: Users,
  project_request: Briefcase,
  credit_session: CircleDollarSign,
};

/** The five chip labels, in `LOOKUP_TYPE_FILTERS` order. */
export const LOOKUP_FILTER_LABEL: Record<LookupTypeFilter, string> = {
  all: 'All',
  people: 'People',
  orgs: 'Companies & agencies',
  sessions: 'Sessions',
  requests: 'Requests',
};

/**
 * Which entity types a chip folds. `null` for `'all'` means "no filter" — `filterByType`
 * treats `null` as "keep everything" rather than an explicit type list.
 */
export const LOOKUP_FILTER_TYPES: Record<LookupTypeFilter, readonly LookupEntityType[] | null> = {
  all: null,
  people: ['user', 'expert'],
  orgs: ['company', 'agency'],
  sessions: ['credit_session'],
  requests: ['project_request'],
};

/** The results a chip filter keeps. `'all'` (or any `null`-mapped filter) is the identity. */
export function filterByType(
  results: readonly LookupResult[],
  filter: LookupTypeFilter
): readonly LookupResult[] {
  const types = LOOKUP_FILTER_TYPES[filter];
  if (types === null) return results;
  return results.filter((result) => types.includes(result.type));
}

/** Live per-chip counts over the CURRENT (unfiltered) result set. */
export function countsByFilter(results: readonly LookupResult[]): Record<LookupTypeFilter, number> {
  const counts = {} as Record<LookupTypeFilter, number>;
  for (const filter of LOOKUP_TYPE_FILTERS) {
    counts[filter] = filterByType(results, filter).length;
  }
  return counts;
}

/** One resolved Open destination. */
export interface LookupOpenTarget {
  readonly href: string;
  readonly label: string;
}

/**
 * The shell's selected-row state — a `LookupResult` when opened from a live search hit, or a
 * `RecentLookupEntry`-derived shape when opened from Recent.
 *
 * BAL-551 fix round F12 — JUDGMENT CALL: `publicExpertUsername` stays `null` for every
 * Recent-sourced selection, DELIBERATELY, even though Recent's own stored entry could
 * technically carry one. `expert/settings/_actions/save-profile.ts` lets an expert rename
 * their public username (`check-username.ts` even checks availability against OTHER
 * profiles), so a username cached in this browser's Recent list can go stale — worse than a
 * dead link, a stale username can be RE-CLAIMED by a DIFFERENT expert, so a staff member
 * clicking "Open" days later could land on the wrong person's public profile with no
 * indication anything was wrong. `resolveOpenTarget` reads this field, not a live lookup, so
 * `null` here is what keeps a Recent-sourced expert selection from ever rendering a link that
 * might silently be pointing at someone else. `via` is what lets the drill-in explain WHY, in
 * copy the viewer sees, rather than only in this comment.
 */
export interface LookupSelection {
  readonly key: string;
  readonly type: LookupEntityType;
  readonly id: string;
  readonly title: string;
  readonly sub: string;
  readonly publicExpertUsername: string | null;
  readonly via: 'search' | 'recent';
}

export function selectionFromResult(result: LookupResult): LookupSelection {
  return {
    key: `${result.type}:${result.id}`,
    type: result.type,
    id: result.id,
    title: result.title,
    sub: result.sub,
    publicExpertUsername: result.publicExpertUsername,
    via: 'search',
  };
}

export function selectionFromRecent(entry: {
  readonly type: LookupEntityType;
  readonly id: string;
  readonly title: string;
  readonly sub: string;
}): LookupSelection {
  return {
    key: `${entry.type}:${entry.id}`,
    type: entry.type,
    id: entry.id,
    title: entry.title,
    sub: entry.sub,
    // See this interface's own docblock (BAL-551 fix round F12) — deliberately never a cached
    // username, on both paths that reach here (a fresh `remember()` call and a stored entry
    // read back from a prior session).
    publicExpertUsername: null,
    via: 'recent',
  };
}

/**
 * The Open-link policy (BAL-551 scope ruling, O3). Render the Open affordance ONLY where it
 * resolves for staff:
 *  - `project_request` → `/projects/{id}` ALWAYS (the admin lens is never denied).
 *  - `expert` → `/experts/{publicExpertUsername}` only when a public profile currently
 *    resolves (approved ∧ searchable ∧ live user, encoded upstream in `publicExpertUsername`).
 *  - `user` / `company` / `agency` / `credit_session` → no page exists for staff. A link that
 *    404s (the client-lens session receipt, `/meetings/{id}`) is worse than no link, so this
 *    returns `null` and the drill-in renders explanatory copy instead.
 */
export function resolveOpenTarget(result: LookupResult): LookupOpenTarget | null {
  if (result.type === 'project_request') {
    return { href: `/projects/${result.id}`, label: 'Open' };
  }
  if (result.type === 'expert' && result.publicExpertUsername !== null) {
    return { href: `/experts/${result.publicExpertUsername}`, label: 'Open' };
  }
  return null;
}

/**
 * How the QUERY looked, not which column matched — a shape heuristic over the raw input, used
 * ONLY for the `admin_lookup_searched` analytics property. The repository does not report which
 * column matched, so this must never be read as match provenance: a uuid could legitimately
 * also appear inside a title, and this classifier would still say `'id'`.
 *
 * BAL-551 fix round F9 — `isLookupUuid` (`@balo/shared/lookup`) is now the ONE uuid predicate,
 * shared with `platform-lookup.ts`'s SQL-side `eq()` gate. REV-4 verified this file's prior
 * local copy (`looksLikeUuid`) agreed with the repository's on every reachable input before the
 * hoist, so consuming the shared one here is a consolidation, not a behaviour change — a false
 * positive/negative would still cost nothing worse than a mis-bucketed metric on this path.
 */
export function classifyLookupQuery(query: string): AdminLookupMatchedBy {
  const trimmed = query.trim();
  if (isLookupUuid(trimmed) || trimmed.toLowerCase().startsWith('pi_')) return 'id';
  if (trimmed.includes('@')) return 'email';
  return 'name';
}
