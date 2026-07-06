import { NextResponse } from 'next/server';
import { z } from 'zod';
import { saveDraftAction } from '@/app/(apply)/expert/apply/_actions/save-draft';
import { log } from '@/lib/logging';

/**
 * JSON endpoint for `navigator.sendBeacon` unload flushes from the expert-apply
 * wizard. A server action cannot be invoked via `sendBeacon` (no way to set the
 * `Next-Action` header / encoding), so this thin route re-uses `saveDraftAction`
 * (which owns auth, Zod validation, and the idempotent/transactional writes).
 * Fire-and-forget from the client; the beacon ignores the response body.
 */
const bodySchema = z.object({
  step: z.enum(['profile', 'products', 'assessment', 'certifications', 'work-history', 'terms']),
  data: z.unknown(),
  expertProfileId: z.string().uuid().optional(),
});

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = bodySchema.parse(await request.json());
    const result = await saveDraftAction(body);
    return NextResponse.json(result);
  } catch (error) {
    // `withAuth` throws `new Error('Unauthorized')` for an unauthenticated request.
    if (error instanceof Error && error.message === 'Unauthorized') {
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
