import { NextResponse } from 'next/server';
import { z } from 'zod';
import { saveDraftAction } from '@/app/(apply)/expert/apply/_actions/save-draft';
import { STEP_CONFIG, type StepKey } from '@/app/(apply)/expert/apply/_actions/schemas';
import { AccountNotLiveError } from '@/lib/auth/account-liveness';
import { log } from '@/lib/logging';

/**
 * JSON endpoint for `navigator.sendBeacon` unload flushes from the expert-apply
 * wizard. A server action cannot be invoked via `sendBeacon` (no way to set the
 * `Next-Action` header / encoding), so this thin route re-uses `saveDraftAction`
 * (which owns auth, Zod validation, and the idempotent/transactional writes).
 * Fire-and-forget from the client; the beacon ignores the response body.
 */
// Derived from STEP_CONFIG rather than re-listed: the hand-written union here had
// already drifted, omitting 'agency' (added by BAL-356), so an agency-step beacon 400d
// while saveDraftAction itself accepted the step. Deriving it can't drift again.
const STEP_KEYS = STEP_CONFIG.map((step) => step.key) as [StepKey, ...StepKey[]];

const bodySchema = z.object({
  step: z.enum(STEP_KEYS),
  data: z.unknown(),
  expertProfileId: z.string().uuid().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = bodySchema.parse(await request.json());
    const result = await saveDraftAction(body);
    return NextResponse.json(result);
  } catch (error) {
    // `withAuth` throws `new Error('Unauthorized')` for an unauthenticated request, and — since
    // BAL-568 — `AccountNotLiveError` for a suspended or soft-deleted one.
    //
    // ⚠⚠ BOTH ARMS ARE REQUIRED, AND THE SECOND IS THE CRACK IN "ZERO CALL-SITE EDITS" (fix round
    // 1, F2). BAL-568 changed the THROW TYPE at the `withAuth` seam without editing any call site —
    // but this is the one place in `apps/web` that branches on the message LITERAL, so a refused
    // account fell through to the "genuine server failure" arm below: a 500 plus a `log.error` for
    // a routine, expected refusal, on every unload beacon, for up to the full seven-day cookie
    // life. Matching on the TYPE is what makes this robust against the next seam-throw change.
    if (
      error instanceof AccountNotLiveError ||
      (error instanceof Error && error.message === 'Unauthorized')
    ) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    // A malformed request — invalid JSON or a body that fails schema validation —
    // is a client error: return 400 and skip server-side error logging.
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return NextResponse.json({ success: false, error: 'flush_failed' }, { status: 400 });
    }
    // Anything else is a genuine server failure — log it and return 500.
    log.error('Failed to flush expert application draft', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ success: false, error: 'flush_failed' }, { status: 500 });
  }
}
