import 'server-only';

import { companiesRepository, expertsRepository, usersRepository } from '@balo/db';
import { personDisplayName } from '@balo/shared/parties';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import { log } from '@/lib/logging';
import { canBookInPage } from './book-in-page';
import { getCallNowRing } from './call-now-api-client';
import type { CallNowCallerView } from './call-now-types';

/** Shown when the other side's name cannot be read. Neutral on both arms. */
const FALLBACK_EXPERT_LABEL = 'your expert';
const FALLBACK_CLIENT_LABEL = 'the client';

/**
 * What the caller's call room shows for the ring in `?ring=`. The ring read is party-scoped by the
 * api, so a ring that is unknown or belongs to someone else is the same absence. `null` unless the
 * viewer is this ring's caller, the ring belongs to this meeting and the viewer still has the case.
 * Every failure degrades to `null`: the room then renders as an ordinary join.
 *
 * The label is read here, never from the URL: the expert's first name for a client caller, the
 * client company for an expert caller. `bookInPage` is `canBookInPage`, the same predicate the
 * case page uses for its "Book a time".
 */
export async function loadCallNowCallerView(input: {
  ringId: string;
  meetingId: string;
  userId: string;
}): Promise<CallNowCallerView | null> {
  const { ringId, meetingId, userId } = input;
  try {
    const ringResult = await getCallNowRing(ringId);
    if (!ringResult.ok) {
      if (ringResult.status !== 404) {
        log.warn('Call room could not read its ring', {
          ringId,
          meetingId,
          status: ringResult.status,
        });
      }
      return null;
    }
    const ring = ringResult.data;
    if (ring.role !== 'caller' || ring.meetingId !== meetingId) return null;

    const access = await resolveCaseAccess(ring.engagementId, userId);
    if (access === null) return null;

    const base = {
      ringId: ring.ringId,
      engagementId: ring.engagementId,
      meetingId: ring.meetingId,
      copyArm: access.lens,
      status: ring.status,
      expiresAtIso: ring.expiresAt,
      reachedBy: ring.reachedBy,
    } as const;

    if (access.lens === 'expert') {
      const company = await companiesRepository.findNameById(access.companyId);
      return {
        ...base,
        calleeLabel: company?.name ?? FALLBACK_CLIENT_LABEL,
        bookInPage: false,
      };
    }

    const profile = await expertsRepository.findDisplayProfileById(access.expertProfileId);
    const expertUser =
      profile === undefined ? undefined : await usersRepository.findDisplayById(profile.userId);
    return {
      ...base,
      calleeLabel: personDisplayName(expertUser?.firstName ?? null, null, FALLBACK_EXPERT_LABEL),
      bookInPage: canBookInPage({
        lens: access.lens,
        // An active engagement is an open case: closing it writes `completed`.
        isOpen: access.conversationWritable,
        hasPublicProfile: (profile?.publicProfileUsername ?? null) !== null,
      }),
    };
  } catch (error) {
    log.warn('Call room could not load its ring view', {
      ringId,
      meetingId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return null;
  }
}
