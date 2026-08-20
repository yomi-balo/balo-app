import { redirect } from 'next/navigation';
import {
  companiesRepository,
  partyMembershipsRepository,
  partyJoinRequestsRepository,
} from '@balo/db';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { JoinResultView } from '../_components/join-result-view';

type JoinPhase = 'approved' | 'declined';

const PARTY_TYPE = 'company' as const;

interface JoinResultPageProps {
  searchParams: Record<string, string | string[] | undefined>;
}

function parsePhase(value: string | string[] | undefined): JoinPhase | null {
  if (value === 'approved' || value === 'declined') return value;
  return null;
}

function parseParty(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Re-validate the party relationship server-side (BAL-348, fail-closed). The
 * `status`/`party` query params are NEVER trusted — the real gate is the materialised
 * state:
 *   - `approved`  → the user must ACTUALLY be a live member of the company.
 *   - `declined`  → the user's MOST-RECENT join request must ACTUALLY be `declined`.
 *                   Any other state — no request at all (the default never-touched
 *                   state), still-`pending`, `approved`, or `withdrawn` — fails closed.
 *                   This is what stops the declined landing from being an existence/
 *                   name oracle: without a real declined row for THIS user, a forged
 *                   `?status=declined&party=<any-uuid>` can no longer confirm a company
 *                   exists or read its name.
 * Returns `true` only when the claimed phase matches reality.
 */
async function revalidateRelationship(
  phase: JoinPhase,
  partyId: string,
  userId: string
): Promise<boolean> {
  if (phase === 'approved') {
    const role = await partyMembershipsRepository.getMemberRole(PARTY_TYPE, partyId, userId);
    return role !== undefined;
  }
  // declined — require a REAL, most-recent `declined` request for this user.
  const latest = await partyJoinRequestsRepository.findLatestByUserAndParty(
    PARTY_TYPE,
    partyId,
    userId
  );
  return latest?.status === 'declined';
}

/**
 * BAL-348 — approved/declined deep-link landing surface. The in-app + email deep-links
 * for `party.join_request_approved` / `party.join_request_declined` land a request-mode
 * requester (who never finished onboarding) here, inside the `(onboarding)` shell.
 *
 * SECURITY (fail-closed): the `status`/`party` query params are re-validated against
 * the materialised membership / request state — a forged, mismatched, or stale link
 * renders nothing here (redirect to /dashboard) and NEVER completes onboarding. This
 * mirrors deliverable B's posture: trust the DB, not the client.
 *
 * LIVE as of BAL-369 / ADR-1038: the org-creation seam shipped, so a company promoted to a
 * shared organization at the onboarding Intent step really can own a domain and field
 * request-mode joins — these deep-links now land real requesters. (The expert→agency
 * `agency.provisioned` path is also live but does not deep-link here.)
 */
export default async function JoinResultPage({
  searchParams,
}: Readonly<JoinResultPageProps>): Promise<React.JSX.Element> {
  const user = await getCurrentUser();
  if (!user) {
    redirect('/login');
  }

  const phase = parsePhase(searchParams.status);
  const partyId = parseParty(searchParams.party);
  if (phase === null || partyId === null) {
    redirect('/dashboard');
  }

  // Read the company name (the ONLY field serialised to the client — no PII crosses the
  // boundary) and re-validate the relationship. All redirects stay OUTSIDE the try so a
  // NEXT_REDIRECT is never swallowed by the catch.
  let companyName: string | undefined;
  let validated = false;
  let readFailed = false;
  try {
    const company = await companiesRepository.findById(partyId);
    companyName = company?.name;
    if (company !== undefined) {
      validated = await revalidateRelationship(phase, partyId, user.id);
    }
  } catch (error) {
    readFailed = true;
    log.error('join-result: relationship re-validation read failed', {
      userId: user.id,
      partyId,
      phase,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  if (readFailed) {
    redirect('/dashboard');
  }

  if (companyName === undefined || !validated) {
    // Forged / mismatched / stale params — fail closed. No onboarding completion.
    log.warn('join-result: rejected unverified deep-link params (fail closed)', {
      userId: user.id,
      partyId,
      phase,
      companyFound: companyName !== undefined,
    });
    redirect('/dashboard');
  }

  return (
    <JoinResultView
      status={phase}
      companyName={companyName}
      alreadyOnboarded={user.onboardingCompleted}
    />
  );
}
