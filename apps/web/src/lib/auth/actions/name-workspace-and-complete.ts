'use server';

import 'server-only';

import { companiesRepository, usersRepository } from '@balo/db';
import { classifyEmailDomain, extractEmailDomain } from '@balo/shared/domains';
import { getSession } from '@/lib/auth/session';
import { companyNameSchema } from '@/lib/auth/company-name-schema';
import { type AuthResult } from '@/lib/auth/errors';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { emitOrgCreatedAtIntent } from '@/lib/analytics/org-intent';
import { log } from '@/lib/logging';

interface NameWorkspaceResult {
  redirectTo: string;
}

const RETRYABLE_ERROR = "We couldn't save that just now. Please try again.";

interface ResolveWorkspaceNameInput {
  userId: string;
  companyId: string;
  email: string;
  emailVerified: boolean;
  companyName: string;
}

type ResolveWorkspaceNameOutcome = { ok: true; name: string } | { ok: false; error: string };

/**
 * BAL-369 / ADR-1038 — decide whether this Intent-step workspace becomes a typed
 * ORGANIZATION (corporate + verified email) or stays a renamed personal workspace
 * (freemail / unverified / agency-owned domain), and perform the write. Extracted from
 * the Server Action so the action body stays within the cognitive-complexity budget;
 * throws propagate to the action's outer try/catch (a genuine DB failure still becomes
 * the retryable error). Returns the resolved company name, or a retryable error when a
 * same-type domain conflict means nothing was written.
 */
async function resolveWorkspaceName(
  input: ResolveWorkspaceNameInput
): Promise<ResolveWorkspaceNameOutcome> {
  const domainClass = classifyEmailDomain(input.email);
  const isCorporateVerified = domainClass === 'corporate' && input.emailVerified;
  // Corporate ⇒ non-null; guard anyway (a blocked/unusable domain classifies freemail).
  const domain = isCorporateVerified ? extractEmailDomain(input.email) : null;

  if (domain === null) {
    // Freemail / unverified (or corporate with no usable domain) → stay personal.
    const renamed = await companiesRepository.updateName(input.companyId, input.companyName);
    return { ok: true, name: renamed.name };
  }

  const result = await companiesRepository.promoteToOrganization({
    companyId: input.companyId,
    name: input.companyName,
    domain,
    actorUserId: input.userId,
  });

  if (result.outcome === 'domain_conflict_same_type') {
    // Another live company owns the domain → retryable, nothing changed. The user
    // stays on the company step and can retry; S4/BAL-372 owns the release rule.
    return { ok: false, error: RETRYABLE_ERROR };
  }

  if (result.outcome === 'promoted') {
    // Analytics, post-commit — a typed org was instantiated at Intent.
    emitOrgCreatedAtIntent('company', 'corporate', input.userId);
    // Notification engine, post-commit, best-effort, dedup on companyId. Rule +
    // template deferred to S3/BAL-371 → publishing now is a correct no-op.
    publishNotificationEvent('company.provisioned', {
      correlationId: result.company.id,
      companyId: result.company.id,
      ownerUserId: input.userId,
    }).catch(() => {
      // publishNotificationEvent logs internally
    });
    return { ok: true, name: result.company.name };
  }

  // domain_conflict_other_type → an agency owns the domain → stay personal.
  const renamed = await companiesRepository.updateName(input.companyId, input.companyName);
  return { ok: true, name: renamed.name };
}

/**
 * BAL-350 CLIENT terminal of onboarding, extended by BAL-369 / ADR-1038
 * ("Organizations by Default"). Validates the workspace name, then — at this Intent
 * step — either PROMOTES the personal workspace into a typed ORGANIZATION (corporate
 * + verified email) or renames it as a personal workspace (freemail / unverified).
 * Marks onboarding complete in client mode and refreshes the session's cached company
 * name. A NEW dedicated action (not an extension of `completeOnboardingAction`) so the
 * untouched expert terminal stays byte-for-byte identical.
 *
 * Uses `getSession()` (not `requireUser()`, which throws on a MISSING user) so an
 * unauthenticated call returns a typed `AuthResult` error instead of throwing. The
 * caller (company step) also validates the name client-side; this re-validates
 * server-side. Authoritative identity (email + verified flag) is RE-READ from the DB
 * (`usersRepository.findById`), never trusted from the session/client. Never throws to
 * the client — always returns the `AuthResult` shape.
 */
export async function nameWorkspaceAndCompleteAction(
  companyName: string
): Promise<AuthResult<NameWorkspaceResult>> {
  const parsed = companyNameSchema.safeParse({ companyName });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? 'Enter a name for your workspace',
    };
  }

  const session = await getSession();
  if (!session?.user?.id) {
    return { success: false, error: 'Unauthorized' };
  }
  if (session.user.onboardingCompleted) {
    return { success: false, error: 'Onboarding already completed' };
  }
  // Least-privilege: only the workspace OWNER may rename/promote the company. At
  // onboarding this always holds (the personal workspace was created with the user as
  // owner and `companyId` is server-derived, never client input), so this is
  // defense-in-depth — forward-safe for when the shared-org creation seam
  // (BAL-345/346) makes non-owner memberships reachable here.
  if (session.user.companyRole !== 'owner') {
    return { success: false, error: 'Unauthorized' };
  }

  try {
    // Authoritative identity re-read — email + verified flag come from the DB, never
    // the session copy, so the corporate-domain gate reflects real state.
    const dbUser = await usersRepository.findById(session.user.id);
    if (dbUser === undefined) {
      return { success: false, error: RETRYABLE_ERROR };
    }

    const resolved = await resolveWorkspaceName({
      userId: session.user.id,
      companyId: session.user.companyId,
      email: dbUser.email,
      emailVerified: dbUser.emailVerified === true,
      companyName: parsed.data.companyName,
    });
    if (!resolved.ok) {
      return { success: false, error: resolved.error };
    }
    const resolvedCompanyName = resolved.name;

    await usersRepository.update(session.user.id, {
      activeMode: 'client',
      onboardingCompleted: true,
    });

    session.user.activeMode = 'client';
    session.user.onboardingCompleted = true;
    session.user.companyName = resolvedCompanyName; // fresh (promoted org, or renamed personal)
    await session.save();

    return { success: true, data: { redirectTo: '/dashboard' } };
  } catch (error) {
    log.error('Failed to name workspace and complete onboarding', {
      userId: session.user.id,
      companyId: session.user.companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: RETRYABLE_ERROR };
  }
}
