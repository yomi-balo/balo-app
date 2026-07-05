'use server';
import 'server-only';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import {
  expertReferralInvitesRepository,
  expertsRepository,
  referenceDataRepository,
} from '@balo/db';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';

/**
 * Input schema for the referral-invite send action (BAL-325). Standalone — it does
 * NOT reuse the retired wizard `inviteStepSchema`. The array cap mirrors the chips
 * input's `maxEmails` default so the client and server agree on the ceiling.
 */
const referralInviteInputSchema = z.object({
  // `.max(254)` per element mirrors the publish schema's `recipientEmail` cap
  // (apps/api/src/routes/notifications/schema.ts) so a >254-char yet format-valid
  // address can't be claimed/persisted here only to be rejected at publish —
  // which would leave an un-emailed row permanently blocking re-invite.
  emails: z.array(z.string().email().max(254)).max(20),
});

export type ReferralInviteStatus = 'sent' | 'already_invited';

export interface ReferralInviteResult {
  email: string;
  status: ReferralInviteStatus;
}

export type SendReferralInvitesResult =
  | {
      ok: true;
      results: ReferralInviteResult[];
      sentCount: number;
      alreadyCount: number;
    }
  | { ok: false; error: 'no_application' | 'invalid_input' | 'unknown' };

/**
 * Build the inviter's display name from the session. BOTH `firstName` and
 * `lastName` are nullable — when neither is set, fall back to a neutral label so
 * the invitation email never reads "undefined invited you…".
 */
function resolveInviterName(firstName: string | null, lastName: string | null): string {
  const name = [firstName, lastName]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join(' ')
    .trim();
  return name.length > 0 ? name : 'A colleague';
}

export const sendReferralInvitesAction = withAuth(
  async (session, input: { emails: string[] }): Promise<SendReferralInvitesResult> => {
    try {
      // 1. Validate input (format + count). Reject before touching the DB.
      const parsed = referralInviteInputSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: 'invalid_input' };
      }

      // 2. Resolve the caller's expert application SERVER-SIDE from the session —
      //    never trust a client-supplied id. No ownership check needed because the
      //    profile is looked up by the authenticated user's own id.
      const vertical = await referenceDataRepository.getSalesforceVertical();
      const application = await expertsRepository.findApplicationByUserId(
        session.user.id,
        vertical.id
      );
      if (!application) {
        return { ok: false, error: 'no_application' };
      }
      const expertProfileId = application.id;

      // 3. Normalize: lowercase + trim + dedupe before claiming (the partial unique
      //    index only guarantees "one per address" if addresses are normalized).
      const emails = [...new Set(parsed.data.emails.map((e) => e.trim().toLowerCase()))].filter(
        (e) => e.length > 0
      );

      const inviterName = resolveInviterName(session.user.firstName, session.user.lastName);

      // 4. Claim + conditionally publish, one address at a time. The insert-returning
      //    gate is the permanent "one invitation per address ever" guarantee: a NEW
      //    row means we publish; a conflict (undefined) means it was already invited
      //    and we NEVER publish again.
      const results: ReferralInviteResult[] = [];
      let sentCount = 0;
      let alreadyCount = 0;

      for (const email of emails) {
        const row = await expertReferralInvitesRepository.claim({
          expertProfileId,
          email,
          invitedByUserId: session.user.id,
        });

        if (row) {
          publishNotificationEvent('expert.referral_invited', {
            correlationId: row.id,
            recipientEmail: email,
            inviterName,
          }).catch(() => {
            // publishNotificationEvent logs transport failures internally.
          });
          results.push({ email, status: 'sent' });
          sentCount += 1;
        } else {
          results.push({ email, status: 'already_invited' });
          alreadyCount += 1;
        }
      }

      log.info('Referral invites dispatched', {
        userId: session.user.id,
        expertProfileId,
        sentCount,
        alreadyCount,
      });

      return { ok: true, results, sentCount, alreadyCount };
    } catch (error) {
      log.error('Failed to send referral invites', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { ok: false, error: 'unknown' };
    }
  }
);
