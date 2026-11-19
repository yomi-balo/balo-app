import 'server-only';

import { caseEngagementsRepository, companiesRepository } from '@balo/db';
import { memberCallPath } from '@/lib/meetings/member-call-path';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';
import { errorMessage, log } from '@/lib/logging';
import { getIncomingCallNowRing } from './call-now-api-client';
import { readCallNowRateLine } from './call-now-rate-line';
import { readExpertFirstName } from './load-call-now-caller-view';
import type { IncomingCallView } from './call-now-types';

/** Shown when the client company's name cannot be read. */
const FALLBACK_CLIENT_LABEL = 'the client';

/**
 * The live ring aimed at `userId`, shaped for the call toast, or `null` when none rings, the
 * viewer no longer has the case, or any read failed. Every failure degrades to `null`: the toast
 * is simply absent and the bell still carries the ring's row.
 *
 * The label is read here, never from the wire: the expert's first name for a client callee, the
 * client company for an expert callee. The rate line is the CLIENT lens only; the expert lens gets
 * `rateLine: null`, so no money string is ever built for an expert. A 404 from the api is the
 * normal "nothing here" and is not logged; any other failure is a `log.warn`.
 */
export async function loadIncomingCall(userId: string): Promise<IncomingCallView | null> {
  try {
    const result = await getIncomingCallNowRing();
    if (!result.ok) {
      if (result.status !== 404) {
        log.warn('Call toast could not read the incoming ring', {
          userId,
          status: result.status,
          code: result.code,
        });
      }
      return null;
    }
    const { ring } = result.data;
    if (ring === null) return null;

    const access = await resolveCaseAccess(ring.engagementId, userId);
    if (access === null || access.lens === ring.callerSide) return null;

    const [callerLabel, rateLine, caseRow] = await Promise.all([
      readCallerLabel(access.lens, access.companyId, access.expertProfileId),
      access.lens === 'client'
        ? readCallNowRateLine(access.expertProfileId)
        : Promise.resolve(null),
      caseEngagementsRepository.findByEngagementId(ring.engagementId),
    ]);

    return {
      ringId: ring.ringId,
      meetingId: ring.meetingId,
      engagementId: ring.engagementId,
      lens: access.lens,
      callerLabel,
      caseTitle: caseRow?.title ?? null,
      rateLine,
      expiresAtIso: ring.expiresAt,
      startedAtIso: ring.startedAt,
      awaitsAnswer: ring.awaitsAnswer,
      joinPath: memberCallPath(ring.meetingId),
      serverNowIso: new Date().toISOString(),
    };
  } catch (error) {
    log.warn('Call toast could not load the incoming ring', {
      userId,
      error: errorMessage(error),
    });
    return null;
  }
}

async function readCallerLabel(
  lens: 'client' | 'expert',
  companyId: string,
  expertProfileId: string
): Promise<string> {
  if (lens === 'client') return readExpertFirstName(expertProfileId);
  const company = await companiesRepository.findNameById(companyId);
  return company?.name ?? FALLBACK_CLIENT_LABEL;
}
