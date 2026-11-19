'use server';

import 'server-only';

import { z } from 'zod';
import { requireOnboardedUser } from '@/lib/auth/session';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { loadCallNowAnswerView } from '@/lib/call-now/load-call-now-answer-view';
import type { CallNowAnswerView } from '@/lib/call-now/call-now-types';
import { log } from '@/lib/logging';

/**
 * BAL-651 — what the call room shows when the join answers `answer_required`: Answer (named, with
 * the rate) for the ring's callee, a wait notice for everyone else, or `retry` when a read failed.
 * The room asks again on every join retry, so a transient failure here costs one more beat of a
 * neutral "Connecting…", never a dead end. The room's own `meetingId` rides along so a ring that
 * belongs to another meeting is never offered here.
 *
 * Read-only: nothing is committed here, and an impersonated session is refused as `wait` (it can
 * never answer, so it must never be offered Answer).
 */
export type ReadCallNowAnswerViewResult = CallNowAnswerView;

const inputSchema = z.object({ ringId: z.uuid(), meetingId: z.uuid() }).strict();

export async function readCallNowAnswerViewAction(input: {
  ringId: string;
  meetingId: string;
}): Promise<ReadCallNowAnswerViewResult> {
  const user = await requireOnboardedUser();

  if (isImpersonatedSession(user)) {
    log.warn('Call now answer view refused — impersonated session', {
      userId: user.id,
      impersonatorUserId: user.impersonatorUserId,
    });
    return { kind: 'wait' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { kind: 'wait' };

  return loadCallNowAnswerView({
    ringId: parsed.data.ringId,
    meetingId: parsed.data.meetingId,
    userId: user.id,
  });
}
