'use server';
import 'server-only';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { log } from '@/lib/logging';
import { calendarApiFetch } from '../_lib/calendar-api';
import type { CalendarProvider } from '../_types/calendar';

export interface DisconnectCalendarInput {
  readonly provider: CalendarProvider;
}

export interface DisconnectCalendarResult {
  success: boolean;
  error?: string;
}

/**
 * ⚠ `provider` IS REQUIRED AT THIS BOUNDARY, AND VALIDATED AT RUNTIME (BAL-397 fix round,
 * security WARNING). `DisconnectCalendarInput` is a TypeScript type — it is erased at runtime
 * and Server Actions are directly POST-able, so a crafted `{}` used to reach the API with
 * `provider` omitted (`JSON.stringify` drops `undefined`). The API's `disconnectBodySchema`
 * makes `provider` optional by design — that absent branch is its documented WHOLE-ACCOUNT
 * contract, looping `disconnectProvider` over every live connection and then soft-deleting the
 * lot — so an unvalidated omission here silently escalated "disconnect Google" into "disconnect
 * everything". Parsing here makes that arm unreachable from this caller. Leave the API's
 * `.optional()` alone; it serves other callers.
 */
const disconnectInputSchema = z.object({
  provider: z.enum(['google', 'microsoft']),
});

/** BAL-397 pre-flight item 3 — disconnect is PER PROVIDER now, not whole-account. */
export const disconnectCalendarAction = withAuth(
  async (session, input: DisconnectCalendarInput): Promise<DisconnectCalendarResult> => {
    const expertProfileId = session.user.expertProfileId;
    if (!expertProfileId) {
      return { success: false, error: 'No expert profile found' };
    }

    const parsed = disconnectInputSchema.safeParse(input);
    if (!parsed.success) {
      log.warn('Rejected disconnect-calendar call with an invalid provider', {
        userId: session.user.id,
        expertProfileId,
      });
      return { success: false, error: 'Failed to disconnect calendar' };
    }
    const { provider } = parsed.data;

    try {
      await calendarApiFetch<{ success: boolean }>('/api/calendar/disconnect', {
        method: 'POST',
        body: JSON.stringify({ expertProfileId, provider }),
      });

      log.info('Calendar disconnected', {
        userId: session.user.id,
        expertProfileId,
        provider,
      });

      revalidatePath('/expert/settings');
      return { success: true };
    } catch (err: unknown) {
      log.error('Failed to disconnect calendar', {
        userId: session.user.id,
        expertProfileId,
        provider,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      // ⚠ A FIXED LITERAL, NEVER `err.message` (BAL-397 fix round, security WARNING). This
      // string is rendered straight into a Sonner toast, and `internalApiFetch` throws four
      // message classes — only the API's own curated `body.error` is safe. The others leak
      // `Internal API returned <status>`, the literal name of the `INTERNAL_API_SECRET` env
      // var, or an undici network error carrying the internal API's private host/IP/port
      // (`connect ECONNREFUSED 10.x.x.x:3002`). The real error is already in `log.error` above,
      // which is where it belongs. `initiate-calendar-connect.ts` and
      // `fix-calendar-permissions.ts` do the same.
      return { success: false, error: 'Failed to disconnect calendar' };
    }
  }
);
