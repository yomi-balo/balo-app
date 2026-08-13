/**
 * BAL-435 (ruling R10) — WHO THE WAITING STAGE IS WAITING FOR.
 *
 * ⚠⚠ IT RUNS **AFTER** AUTHORIZATION, ON THE MEMBER ARM ONLY, AND IT ADDS NO NEW ACCESS. Its two
 * inputs — the owning `companyId` and the delivering `expertProfileId` — are what
 * `authorizeMeetingParticipation` ALREADY resolved from the meeting's own primary context, so
 * nothing here re-derives tenancy and nothing here reads from caller input. It must never be
 * called from the guest or lobby arms: Decision 9's no-oracle rule governs those callers, and an
 * anonymous visitor learning which company a meeting belongs to is exactly what it forbids.
 *
 * ── ⚠⚠ WHY THE TWO SIDES ANSWER DIFFERENT **KINDS** OF NAME ─────────────────────────────────
 *
 *   · A CLIENT is waiting ⇒ the missing party is the DELIVERING EXPERT, and that side names
 *     exactly ONE individual (`expert_profiles.user_id`). A person joins a call, so the person's
 *     FIRST NAME is the honest answer.
 *   · An EXPERT is waiting ⇒ the missing party is the CLIENT, and that side names NO individual:
 *     `meetings` records a company, never a booker. So the answer is the COMPANY's name — which
 *     is also what CLAUDE.md's attribution rule asks for in prospective copy ("Northwind has 7
 *     days to review"). ⚠ DO NOT "improve" this by guessing a person from company membership: a
 *     confidently wrong name on a live call is worse than a party name, and picking one member of
 *     several would be a fabrication.
 *
 * ⚠ IT NEVER THROWS AND IT NEVER FAILS THE JOIN. A name is decoration on a surface whose job is
 * to connect a call; a repository wobble degrades to `null`, and `apps/web` then renders
 * party-neutral copy rather than a guess.
 *
 * ⚠ `null` IS A FIRST-CLASS ANSWER, not a failure: a `match`-routed `project_discovery` has NO
 * expert at all (`expertProfileId` is null by construction), and that is a live shape.
 */
import { companiesRepository, expertsRepository, usersRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import type { MeetingViewerRole } from '@balo/shared/meetings';

const log = createLogger('meeting-waiting-counterparty');

export interface ResolveWaitingCounterpartyInput {
  /** ⚠ THE GATE'S OWN VERDICT. Never a lens, never `activeMode`, never request input. */
  readonly viewerRole: MeetingViewerRole;
  /** The company that owns the primary context, already resolved by the gate. */
  readonly companyId: string;
  /** The delivering expert profile, or `null` for a `match`-routed discovery call. */
  readonly expertProfileId: string | null;
}

/** Trim and normalise an empty name to `null` — an empty `{Name}` reads as a bug. */
function normalise(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

/** The delivering expert's FIRST name. ⚠ Two focused reads; never a hydrated user row. */
async function expertFirstName(expertProfileId: string | null): Promise<string | null> {
  if (expertProfileId === null) return null;
  const profile = await expertsRepository.findDisplayProfileById(expertProfileId);
  if (profile === undefined) return null;
  // ⚠ `findNamesByIds` PROJECTS FIRST AND LAST NAME ONLY — never `findById`, which hydrates
  // `workosId`, email and phone into a value that flows to a browser (memory
  // `reference_drizzle_with_hydration_leaks_secrets`).
  const [person] = await usersRepository.findNamesByIds([profile.userId]);
  return normalise(person?.firstName);
}

/** The client company's name. ⚠ `findNameById`, not `findById` — billing details have no place here. */
async function clientPartyName(companyId: string): Promise<string | null> {
  const company = await companiesRepository.findNameById(companyId);
  return normalise(company?.name);
}

/**
 * The name the waiting copy addresses, or `null` when nothing safe resolved.
 */
export async function resolveWaitingCounterparty(
  input: ResolveWaitingCounterpartyInput
): Promise<string | null> {
  try {
    if (input.viewerRole === 'client') {
      return await expertFirstName(input.expertProfileId);
    }
    return await clientPartyName(input.companyId);
  } catch (error) {
    // ⚠ HANDLED, NOT RE-THROWN — so CLAUDE.md's rule applies and the original reason survives.
    // ⚠ NO NAME VALUE IN THIS LOG; the ids already identify the rows.
    log.error(
      {
        viewerRole: input.viewerRole,
        companyId: input.companyId,
        expertProfileId: input.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Waiting counterparty lookup failed — falling back to neutral copy'
    );
    return null;
  }
}
