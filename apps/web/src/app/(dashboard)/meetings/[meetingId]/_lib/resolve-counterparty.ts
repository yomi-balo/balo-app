import 'server-only';

import { agenciesRepository, expertsRepository, usersRepository } from '@balo/db';
import {
  expertPartyDisplayName,
  personDisplayName,
  personWithOrgLabel,
} from '@balo/shared/parties';
import type { RecapLens, RecapPartyView } from '@/lib/meetings/recap-view-types';

/**
 * resolve-counterparty — WHO THE OTHER SIDE OF THIS MEETING IS, named once.
 *
 * ⚠⚠ A PURE MOVE OUT OF `load-recap.ts` (BAL-389), NOT A REWRITE. `resolveCounterparty`,
 * `initialsOf`, `CounterpartyLabels` and `RecapExpertProfile` were module-private there. The
 * end-of-call screen needs the SAME two labels (the expert's short given name on the client
 * lens; the client company on the expert lens), and re-deriving them means the identical
 * four-call shape — `findDisplayProfileById` + `findDisplayById` + `getSummaryById` +
 * `personDisplayName`/`expertPartyDisplayName`/`personWithOrgLabel`. That is both the exact
 * duplication SonarCloud's >3% new-code gate catches (memory
 * `reference_sonar_duplication_not_caught_locally`) AND a second place counterparty
 * concealment could drift. `load-recap.ts` now imports from here; its behaviour and its test
 * are unchanged.
 *
 * ⚠⚠ EVERY COUNTERPARTY READ IS COLUMN-PROJECTED AT THE REPOSITORY, NOT NARROWED HERE — AND
 * THAT REASONING MOVED WITH THE CODE BECAUSE IT IS THE WHOLE POINT OF THE FILE.
 * `usersRepository.findDisplayById` (id/first/last/avatar), `expertsRepository
 * .findDisplayProfileById` (six display columns) and `agenciesRepository.getSummaryById` exist
 * precisely so this module CANNOT hold `users.email`, `users.workosId` or
 * `expert_profiles.rate_cents` in the first place. That last one matters most: `rate_cents` is
 * the UN-MARKED-UP consultant rate, and a client-lens payload already carries the all-in
 * charge, so a payload holding both would hand the client the Balo margin. A bare relational
 * hydrate plus a field-by-field projection downstream would LOOK identical and be one careless
 * spread away from leaking, because TypeScript excess-property checking does NOT apply to
 * spreads (memory `reference_drizzle_with_hydration_leaks_secrets`). Concealment is enforced
 * by what the ROWS can hold, not by remembering to omit things downstream.
 *
 * ⚠ NO EMAIL ADDRESS IS EVER PRODUCED HERE (ADR-1044). Names and org labels cross the party
 * boundary; addresses never do — not in a label, not in an avatar URL, not in initials.
 */

/**
 * The PROJECTED expert-profile row a meeting surface is allowed to hold — six display columns,
 * and structurally NOT `rateCents` / `stripeConnectId`. Derived from the
 * repository so the two cannot drift.
 *
 * ⚠ MODULE-PRIVATE, exactly as it was in `load-recap.ts` before the move. Callers pass the
 * repository row straight through and structural typing does the rest — `load-recap.ts` imports
 * only `resolveCounterparty`, `resolveRequesterLabel` and `CounterpartyLabels`. Exporting it
 * would widen this file's public surface for no consumer.
 */
type RecapExpertProfile = NonNullable<
  Awaited<ReturnType<typeof expertsRepository.findDisplayProfileById>>
>;

export interface CounterpartyLabels {
  party: RecapPartyView;
  /** Retrospective — person @ agency on first mention. Used by R11 and the R4 banner. */
  expertPersonLabel: string;
  /** Prospective — the expert PARTY short label, for action-item assignee chips. */
  expertPartyShort: string;
  /** The bare person/party name the resolve dialog copy uses. */
  expertShortName: string;
  /** The delivering expert's agency name, or `null` for an independent expert. */
  agencyLabel: string | null;
}

/** Up to two initials for the avatar fallback. NEVER derived from an email address. */
export function initialsOf(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  const [first, second] = parts;
  if (first === undefined) return '?';
  const tail = second === undefined ? '' : second.charAt(0);
  return (first.charAt(0) + tail).toUpperCase();
}

/**
 * The §R8 party card, both lenses.
 *
 * CLIENT LENS → the delivering EXPERT: photo, person name, headline, agency, rating.
 * EXPERT LENS  → the client PARTY, i.e. the company. CLAUDE.md's attribution rule makes that
 * the right call rather than a shortcut: client-side rights sit on COMPANY membership and
 * survive individual departures, so there is no single client PERSON to name here.
 *
 * ⚠⚠ THE RATING IS CLIENT-LENS ONLY (BAL-422). `expert_profiles.rating_average` /
 * `rating_count` now exist and `findDisplayProfileById` projects them, so the client lens
 * carries the delivering expert's real aggregate. THE EXPERT LENS STILL CARRIES NOTHING
 * EVALUATIVE — it hardcodes `ratingAverage: null` / `ratingCount: 0` below, because the
 * expert is not scoring the client and a company has no rating aggregate to begin with.
 *
 * ⚠ `null` means NO REVIEWS, never 0.0 — `PartyCard` null-gates and renders nothing.
 *
 * ⚠⚠ TWO CALLERS, BUT ONLY ONE RENDERS `party`. `load-recap.ts` renders the party card and so
 * shows the rating. `load-end-of-call.ts` (BAL-389) also calls this — that shared naming is
 * why the file exists — but it reads ONLY `expertShortName` / `agencyLabel` and NEVER touches
 * `party` (its own comment at the call site says so). So the rating is computed and discarded
 * on the end-of-call path: NOTHING new renders there because of BAL-422.
 *
 * ⚠ THAT IS LEFT UNGATED ON PURPOSE. No component-level suppression was added, so if the
 * end-of-call screen ever adopts the party card it inherits the same client-lens rating with
 * no change here. Do not add a gate, and do not describe end-of-call as already showing it.
 */
export async function resolveCounterparty(
  lens: RecapLens,
  profile: RecapExpertProfile | undefined,
  clientCompanyName: string,
  ordinalLine: string | null
): Promise<CounterpartyLabels> {
  const [expertUser, agency] = await Promise.all([
    profile === undefined
      ? Promise.resolve(undefined)
      : usersRepository.findDisplayById(profile.userId),
    profile?.agencyId == null
      ? Promise.resolve(undefined)
      : agenciesRepository.getSummaryById(profile.agencyId),
  ]);
  const agencyLabel = agency?.name ?? null;
  const firstName = expertUser?.firstName ?? null;
  const lastName = expertUser?.lastName ?? null;

  const expertPerson = personDisplayName(firstName, lastName, 'An expert');
  const expertPartyShort = expertPartyDisplayName({
    type: profile?.type ?? 'freelancer',
    agencyName: agencyLabel,
    firstName,
    lastName,
  });
  const shared = {
    expertPersonLabel: personWithOrgLabel(expertPerson, agencyLabel),
    expertPartyShort,
    expertShortName: personDisplayName(firstName, null, expertPartyShort),
    agencyLabel,
  };

  if (lens === 'client') {
    // ⚠ `expert_profiles.username` IS NULLABLE. A null username means NO CTA at all — never a
    // disabled button, and never an href pointing at `/experts/null`.
    const username = profile?.username ?? null;
    return {
      ...shared,
      party: {
        name: expertPerson,
        headline: profile?.headline ?? null,
        orgLabel: agencyLabel,
        avatarUrl: expertUser?.avatarUrl ?? null,
        initials: initialsOf(expertPerson),
        ordinalLine,
        bookAgainHref: username === null ? null : '/experts/' + username,
        // BAL-422 — already parsed to a number by `findDisplayProfileById`.
        ratingAverage: profile?.ratingAverage ?? null,
        ratingCount: profile?.ratingCount ?? 0,
      },
    };
  }

  return {
    ...shared,
    party: {
      name: clientCompanyName,
      headline: null,
      orgLabel: null,
      avatarUrl: null,
      initials: initialsOf(clientCompanyName),
      ordinalLine,
      // ⚠ EVERY expert-side CTA the design listed (send proposal, private note, offer a new
      // time) has NO live destination today, so the card renders none. It must read complete
      // with one action or with zero — a disabled CTA is worse than an absent one.
      bookAgainHref: null,
      // ⚠⚠ NOTHING EVALUATIVE ON THE EXPERT LENS (BAL-422). The counterparty here is the
      // client COMPANY; the expert is not scoring the client, and companies carry no rating
      // aggregate at all. Hardcoded, not derived — do not "wire" these.
      ratingAverage: null,
      ratingCount: 0,
    },
  };
}

/** The two name columns `formatRequesterLabel` reads. Derived from the repository projection. */
type RequesterNames = Awaited<ReturnType<typeof usersRepository.findNamesByIds>>[number];

/**
 * Retrospective attribution for whoever asked that a case be resolved — the PERSON, with
 * "@ agency" on first mention (CLAUDE.md), bare for an independent expert.
 *
 * ⚠⚠ THE **FORMATTING** IS THE SHARED PART, AND IT IS THIS FUNCTION. The recap's R4 banner and
 * the end-of-call screen's resolve prompt both name the requester, and duplicating the
 * `personDisplayName` + `personWithOrgLabel` pair across two routes is a drift risk on an
 * ATTRIBUTION rule — the one kind of copy CLAUDE.md pins by tense (prospective names the PARTY;
 * retrospective names the PERSON). The FETCH is deliberately NOT shared: the two callers can
 * schedule it differently (see `resolveRequesterLabel` below, and BAL-389's end-of-call loader,
 * which runs it alongside the counterparty read instead of after it) and there is nothing
 * rule-shaped about a repository call.
 *
 * `fallbackName` is used when the user row has no name to show — never an email address, and
 * never a raw id.
 */
export function formatRequesterLabel(
  requester: RequesterNames | undefined,
  agencyLabel: string | null,
  fallbackName: string
): string {
  const requesterName = personDisplayName(
    requester?.firstName ?? null,
    requester?.lastName ?? null,
    fallbackName
  );
  return personWithOrgLabel(requesterName, agencyLabel);
}

/**
 * Fetch-then-format, for callers with nothing to overlap the read with.
 *
 * ⚠ `load-recap.ts` USES THIS AND IS UNCHANGED. It already has the requester id in hand at a
 * point where nothing else is outstanding, so a separate await costs it nothing.
 */
export async function resolveRequesterLabel(
  requestedByUserId: string,
  agencyLabel: string | null,
  fallbackName: string
): Promise<string> {
  const [requester] = await usersRepository.findNamesByIds([requestedByUserId]);
  return formatRequesterLabel(requester, agencyLabel, fallbackName);
}
