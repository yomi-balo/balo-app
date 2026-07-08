'use server';
import 'server-only';

import { z } from 'zod';
import { expertsRepository, usersRepository, AgencyDomainCaptureConflictError } from '@balo/db';
import { withAuth } from '@/lib/auth/with-auth';
import {
  runLinkExpertAgency,
  publishAgencyResolutionNotifications,
} from '@/lib/expert-agency/link-expert-agency';
import type { LinkExpertAgencyActionResult } from '@/lib/expert-agency/types';
import { log } from '@/lib/logging';

export type { LinkExpertAgencyActionResult } from '@/lib/expert-agency/types';

const inputSchema = z.object({ expertProfileId: z.string().uuid() });

const RETRYABLE_ERROR =
  "We couldn't finish setting this up just now. Nothing was changed — please try again.";

/**
 * BAL-356 / ADR-1034 — the authoritative expert→agency WRITE Server Action. Runs the
 * real writes for every expert (SHIP LIVE, no flag): provision & solo create the
 * agency + set `expert_profiles.agencyId`; join activates as agencies come to own
 * domains.
 *
 * Security (workos-auth):
 *   - `withAuth` guarantees a session (fails closed on no auth).
 *   - The outcome is RE-RESOLVED server-side from the DB-authoritative email + verified
 *     flag (`users` row) — the client never supplies a `kind`; only the
 *     `expertProfileId` is accepted (Zod-validated). An UNVERIFIED email re-resolves to
 *     solo (ADR-1034 gate) → `provisionSolo`, never provision/join a domain.
 *   - Ownership is verified (`profile.userId === session.user.id`) before any write.
 *
 * FAILS CLOSED: any error (including a lost domain-capture race →
 * `AgencyDomainCaptureConflictError`) returns `{ success:false, error }` with a
 * retryable message; the tx rolled back, so nothing changed. On retry the resolver
 * sees `partyType==='agency'` and routes to JOIN (self-healing race).
 */
export const linkExpertAgencyAction = withAuth(
  async (session, raw: unknown): Promise<LinkExpertAgencyActionResult> => {
    try {
      const { expertProfileId } = inputSchema.parse(raw);

      // Ownership guard — never link a profile the caller doesn't own.
      const owns = await expertsRepository.findProfileById(expertProfileId);
      if (!owns || owns.userId !== session.user.id) {
        return { success: false, error: 'Unauthorized' };
      }

      // Authoritative user read — email + verified flag come from the DB (never the
      // session copy), so the ADR-1034 verified-email gate reflects real state. An
      // unverified email re-resolves to solo (no domain capture/join).
      const dbUser = await usersRepository.findById(session.user.id);
      if (dbUser === undefined) {
        // Defensive: an authed user should always have a row. Fail closed, retryable.
        return { success: false, error: RETRYABLE_ERROR };
      }

      const result = await runLinkExpertAgency({
        userId: session.user.id,
        email: dbUser.email,
        emailVerified: dbUser.emailVerified,
        firstName: session.user.firstName,
        lastName: session.user.lastName,
        expertProfileId,
      });

      // Post-commit, best-effort — only on the fresh create/join branch.
      if (result.fresh) {
        await publishAgencyResolutionNotifications(result, session.user.id);
      }

      log.info('Expert agency resolved', {
        userId: session.user.id,
        expertProfileId,
        outcome: result.outcome,
        agencyId: result.agencyId,
      });

      return { success: true, outcome: result.outcome, agencyId: result.agencyId };
    } catch (error) {
      const isCaptureConflict = error instanceof AgencyDomainCaptureConflictError;
      log.error('Expert agency link failed', {
        userId: session.user.id,
        isCaptureConflict,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      // Fail closed with a retryable message (a lost capture race re-resolves to JOIN
      // on retry). Same message for every failure — nothing was changed.
      return { success: false, error: RETRYABLE_ERROR };
    }
  }
);
