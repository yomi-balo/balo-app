/**
 * parties — the PURE, transport-agnostic counterpart display-name helper
 * (BAL-329 / BAL-336). NO `db` import, NO I/O: it takes PRIMITIVE fields (an
 * expert party `type` plus the agency/person names) so BOTH the server-side A7
 * inbox loader (D6) AND D1's client-side workspace components can import it via
 * the `@balo/shared/parties` subpath without dragging the postgres driver into
 * any client bundle — the same isolation rationale as `@balo/shared/domains`.
 */

/** The expert party kind — mirrors `expertTypeEnum` without importing `@balo/db`. */
export type ExpertPartyType = 'freelancer' | 'agency';

/** The primitive fields the display-name convention needs (never a full DB row). */
export interface ExpertPartyNameInput {
  type: ExpertPartyType;
  agencyName: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * The single name-joining primitive: non-empty name parts joined, else `fallback`.
 * Used by `expertPartyDisplayName` and `engagementActorAttribution` below, and by
 * feature view-models (e.g. the D5 oversight derivers) — import this rather than
 * redefining the join anywhere.
 */
export function personDisplayName(
  firstName: string | null,
  lastName: string | null,
  fallback = 'Unknown'
): string {
  const full = [firstName, lastName]
    .filter((part): part is string => part !== null && part.trim().length > 0)
    .join(' ')
    .trim();
  return full.length > 0 ? full : fallback;
}

/**
 * Party-vs-person convention (BAL-329): an agency shows its agency name; a
 * freelancer — or an agency whose name is blank — shows the person's name.
 * Falls back to a neutral "An expert" when no name resolves. Shared by D6 (inbox)
 * and D1 (workspace). Do NOT reuse submit-eoi.ts's person-only helper.
 */
export function expertPartyDisplayName(party: ExpertPartyNameInput): string {
  if (party.type === 'agency') {
    const agency = party.agencyName?.trim();
    if (agency) return agency;
  }
  return personDisplayName(party.firstName, party.lastName, 'An expert');
}

/**
 * `"Dana @ Northwind Industrial"` — or just `"Dana"` when there is no SEPARATE party to
 * name. The one place the "@ org" clause is decided, so no surface has to re-derive it.
 *
 * ⚠ THE CLAUSE IS DROPPED, NEVER FILLED WITH A PLACEHOLDER, in three cases:
 *   · the org label is absent or blank — CLAUDE.md's attribution rule says name the party
 *     you know, not a stand-in. `"Dana @ their team"` reads like an unsubstituted template
 *     variable, which is worse than the bare name it was trying to improve on;
 *   · the org label IS the person's name. An INDEPENDENT expert has no agency, so callers
 *     legitimately set the org label to the person ("the person IS the party") — and a
 *     naive concatenation then renders `"Dana Okoro @ Dana Okoro"`. CLAUDE.md states the
 *     rule directly: "independent experts keep their own name";
 *   · the person's own name is missing, in which case the org label stands alone.
 *
 * Comparison is trimmed and case-insensitive: the two halves reach this function from
 * different reads (a `users` row and a `companies`/`agencies` row), so they can differ only
 * in casing or padding and still be the same party.
 *
 * `engagementActorAttribution` below applies the same rule for its own inputs; this is the
 * primitive for callers that have already resolved the two strings themselves.
 */
export function personWithOrgLabel(
  personName: string,
  orgLabel: string | null | undefined
): string {
  const person = personName.trim();
  const org = orgLabel?.trim() ?? '';
  if (org.length === 0) return person;
  if (person.length === 0) return org;
  if (person.toLowerCase() === org.toLowerCase()) return person;
  return `${person} @ ${org}`;
}

/** A person's platform role — mirrors `users.platformRole` without importing `@balo/db`. */
export type PlatformRole = 'user' | 'admin' | 'super_admin';

/**
 * Platform roles that make an actor Balo STAFF (not a marketplace party). The one
 * shared source of truth — web's `lib/auth/is-admin` and the attribution rule below
 * both consume it; do NOT hand-roll a second `ADMIN_ROLES` set.
 */
export const PLATFORM_ADMIN_ROLES: ReadonlySet<PlatformRole> = new Set(['admin', 'super_admin']);

/** True when a platform role is a Balo-staff (admin / super-admin) role. */
export function isPlatformAdminRole(role: PlatformRole): boolean {
  return PLATFORM_ADMIN_ROLES.has(role);
}

/** Which surface the attribution renders on — see `engagementActorAttribution`. */
export type AttributionAudience = 'internal' | 'external';

/** The primitives the engagement actor-attribution rule needs (never a full DB row). */
export interface EngagementActorAttributionInput {
  /** The acting person: identity + name parts + platform role. */
  actor: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    platformRole: PlatformRole;
  };
  /** The engagement's expert person id — an actor matching it IS the expert party. */
  expertUserId: string;
  /** The expert's agency name (agency-based) or null (freelancer). */
  expertAgencyName: string | null;
  /** The engagement's client company name — the default marketplace affiliation. */
  companyName: string;
}

/**
 * Retrospective attribution for an engagement actor (who accepted / cancelled a
 * project), derived from DATA (role + identity), never hard-coded — so any future
 * surface (e.g. D4's client/expert cancel path) reuses this one rule instead of
 * re-deriving an affiliation from strings. BAL-329 party/person convention, by
 * AUDIENCE:
 *
 *  · BALO STAFF (`platformRole` admin/super_admin):
 *      – INTERNAL surfaces (admin oversight, this PR) NAME THE PERSON: "MJ @ Balo".
 *      – EXTERNAL surfaces (client/expert-facing) name only the PARTY: "Balo".
 *  · MARKETPLACE ACTORS (client members, experts): person-named on ALL surfaces —
 *      an expert actor follows the expert label rule ("{name} @ {agency}" or bare
 *      name for a freelancer); any other actor is a client member → "{name} @
 *      {company}".
 *
 * D5 renders `internal` only; the `external` branch exists so D4 does not re-derive
 * the rule.
 */
export function engagementActorAttribution(
  input: EngagementActorAttributionInput,
  audience: AttributionAudience = 'internal'
): string {
  const { actor, expertUserId, expertAgencyName, companyName } = input;
  const name = personDisplayName(actor.firstName, actor.lastName);
  if (isPlatformAdminRole(actor.platformRole)) {
    return audience === 'external' ? 'Balo' : `${name} @ Balo`;
  }
  if (actor.id === expertUserId) {
    // Freelancer (null agency) → bare name; agency expert → "{name} @ {agency}".
    return personWithOrgLabel(name, expertAgencyName);
  }
  return personWithOrgLabel(name, companyName);
}
