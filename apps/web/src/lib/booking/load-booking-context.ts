import 'server-only';

import {
  agenciesRepository,
  caseEngagementsRepository,
  expertsRepository,
  partyMembershipsRepository,
  usersRepository,
} from '@balo/db';
import type { EligibleCompany } from '@balo/shared/credit';
import { expertPartyDisplayName } from '@balo/shared/parties';
import { CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';

/**
 * BAL-400 (Decision 1a / Decision 5) — the booking wrapper's "Step 0" server read: which
 * company this booking bills to, the client's open cases with this expert, and the expert's
 * display fields. Resolved BEFORE the wrapper renders so the three arms below never flash a
 * loading state for the company question.
 *
 * ⚠⚠ THE COMPANY READ IS LOAD-BEARING AND FAILS CLOSED. `partyMembershipsRepository
 * .listCapabilityEligibleCompanies` deciding who may draw a wallet is the whole reason this
 * module exists (D1a) — a transport hiccup here must disable Confirm, never silently fall
 * back to "assume one company". `arm: 'company_read_failed'` is that fail-closed branch.
 *
 * ⚠ THE OPEN-CASES READ IS NON-BLOCKING (design principle: never block on a non-critical
 * read). A failure there degrades to an empty open-case list — the booking flow still works,
 * it just offers new-case only instead of an attach chooser.
 *
 * THE THREE ELIGIBLE-COMPANY ARMS (D1a):
 *   0 companies  → `onboarding_required` — not a booking error, route to onboarding.
 *   1 company    → `single_company` — used silently, no picker; the open-case read runs
 *                  immediately because the billing company is already known.
 *   >1 companies → `choose_company` — the picker renders; the open-case read is DEFERRED
 *                  (a case is company-scoped, so a cross-company open-case list would be
 *                  incoherent) until Phase 4 wires the picker's own resolution call.
 */

export interface BookingExpertDisplay {
  /** `null` when the expert user has no first name on file. Never a fallback string here. */
  firstName: string | null;
  /** Prospective copy names the PARTY (CLAUDE.md) — the agency name, or the expert's own name. */
  partyLabel: string;
}

/** {@link caseEngagementsRepository.listOpenForCompanyAndExpert}'s result, without a barrel type export. */
type OpenCasesForExpert = Awaited<
  ReturnType<typeof caseEngagementsRepository.listOpenForCompanyAndExpert>
>;
export type OpenCaseForExpert = OpenCasesForExpert['openCases'][number];

export type BookingContext =
  | { readonly arm: 'onboarding_required' }
  | { readonly arm: 'company_read_failed' }
  | {
      readonly arm: 'choose_company';
      readonly companies: readonly EligibleCompany[];
      readonly expert: BookingExpertDisplay;
    }
  | {
      readonly arm: 'single_company';
      readonly company: EligibleCompany;
      readonly openCases: readonly OpenCaseForExpert[];
      readonly resolvedCaseCount: number;
      readonly expert: BookingExpertDisplay;
    };

const FALLBACK_EXPERT_DISPLAY: BookingExpertDisplay = { firstName: null, partyLabel: 'An expert' };

/**
 * The expert's display fields for the booking header/copy — `firstName` (personal address)
 * and `partyLabel` (the prospective PARTY name: agency, or the independent expert's own name).
 * Mirrors `resolve-counterparty.ts`'s shape without the client-lens-only rating/headline
 * fields this surface doesn't render.
 *
 * ⚠ NEVER THROWS. A missing/unresolvable expert profile degrades to
 * {@link FALLBACK_EXPERT_DISPLAY} rather than failing the whole Step 0 read — the booking CTA
 * itself already implies a resolvable expert, so this is defence-in-depth, not the primary
 * existence check.
 *
 * EXPORTED so `actions/book-consultation.ts` can resolve the SAME `expertPartyLabel` for the
 * `booking.confirmed` notification payload without a second three-repository-call copy of this
 * resolution (the `resolve-counterparty.ts` "extracted, not copied" precedent).
 */
export async function resolveBookingExpertDisplay(
  expertProfileId: string
): Promise<BookingExpertDisplay> {
  try {
    const profile = await expertsRepository.findDisplayProfileById(expertProfileId);
    if (profile === undefined) {
      return FALLBACK_EXPERT_DISPLAY;
    }
    const [expertUser, agency] = await Promise.all([
      usersRepository.findDisplayById(profile.userId),
      profile.agencyId === null
        ? Promise.resolve(undefined)
        : agenciesRepository.getSummaryById(profile.agencyId),
    ]);
    const agencyLabel = agency?.name ?? null;
    const firstName = expertUser?.firstName ?? null;
    const partyLabel = expertPartyDisplayName({
      type: profile.type,
      agencyName: agencyLabel,
      firstName,
      lastName: expertUser?.lastName ?? null,
    });
    return { firstName, partyLabel };
  } catch (error) {
    log.warn('Booking expert display read failed; degrading to a neutral label', {
      expertProfileId,
      error: error instanceof Error ? error.message : String(error),
    });
    return FALLBACK_EXPERT_DISPLAY;
  }
}

/** The open-case read, non-blocking per the module docblock. */
async function resolveOpenCases(
  companyId: string,
  expertProfileId: string
): Promise<{ openCases: readonly OpenCaseForExpert[]; resolvedCaseCount: number }> {
  try {
    return await caseEngagementsRepository.listOpenForCompanyAndExpert({
      companyId,
      expertProfileId,
    });
  } catch (error) {
    log.warn('Open-case list unavailable; degrading to new-case', {
      companyId,
      expertProfileId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { openCases: [], resolvedCaseCount: 0 };
  }
}

export async function loadBookingContext(
  expertProfileId: string,
  userId: string
): Promise<BookingContext> {
  const [companies, expert] = await Promise.all([
    (async (): Promise<readonly EligibleCompany[] | undefined> => {
      try {
        return await partyMembershipsRepository.listCapabilityEligibleCompanies(
          userId,
          CAPABILITIES.CONSUME_CREDITS
        );
      } catch (error) {
        log.error('Company eligibility read failed', {
          userId,
          expertProfileId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        return undefined;
      }
    })(),
    resolveBookingExpertDisplay(expertProfileId),
  ]);

  if (companies === undefined) {
    return { arm: 'company_read_failed' };
  }
  if (companies.length === 0) {
    return { arm: 'onboarding_required' };
  }
  if (companies.length > 1) {
    return { arm: 'choose_company', companies, expert };
  }

  const [company] = companies;
  if (company === undefined) {
    // Unreachable (length === 1 above guarantees an element), guarded for
    // `noUncheckedIndexedAccess` rather than a non-null assertion.
    return { arm: 'onboarding_required' };
  }

  const { openCases, resolvedCaseCount } = await resolveOpenCases(company.id, expertProfileId);

  return { arm: 'single_company', company, openCases, resolvedCaseCount, expert };
}
