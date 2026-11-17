'use server';
import 'server-only';

import { z } from 'zod';
import { usersRepository } from '@balo/db';
import { CLIENT_SMS_CONSENT_SURFACES } from '@balo/analytics/events';
import { withAuth } from '@/lib/auth/with-auth';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { log } from '@/lib/logging';
import type {
  ClientSmsConsentResult,
  ClientSmsConsentState,
  ClientSmsConsentSurface,
} from './types';

/**
 * Client SMS consent (BAL-655). Both actions act only on the signed-in user, so they need no
 * capability. Consent is a personal choice, so an impersonated session can neither read nor change
 * it (same stance as `./actions.ts`).
 */

const setConsentInputSchema = z.object({
  optedIn: z.boolean(),
  surface: z.enum(CLIENT_SMS_CONSENT_SURFACES),
});

export const getClientSmsConsentStateAction = withAuth(
  async (session): Promise<ClientSmsConsentState> => {
    if (isImpersonatedSession(session.user)) return { status: 'unavailable' };

    try {
      const consent = await usersRepository.findClientSmsConsent(session.user.id);
      if (consent === undefined) return { status: 'unavailable' };

      const { phone, phoneVerifiedAt, clientSmsOptedInAt } = consent;
      const verifiedPhone = phone !== null && phoneVerifiedAt !== null ? phone : null;
      if (clientSmsOptedInAt !== null && verifiedPhone !== null) {
        return { status: 'opted_in', phone: verifiedPhone };
      }
      return { status: 'not_opted_in', verifiedPhone };
    } catch (error) {
      log.error('Failed to read client SMS consent', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { status: 'unavailable' };
    }
  }
);

export const setClientSmsConsentAction = withAuth(
  async (
    session,
    input: { optedIn: boolean; surface: ClientSmsConsentSurface }
  ): Promise<ClientSmsConsentResult> => {
    const parsed = setConsentInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: 'request_failed' };
    const { optedIn, surface } = parsed.data;

    if (isImpersonatedSession(session.user)) {
      log.warn('Client SMS consent change refused — impersonated session', {
        userId: session.user.id,
        impersonatorUserId: session.user.impersonatorUserId,
        surface,
      });
      return { ok: false, code: 'impersonation_refused' };
    }

    try {
      const { outcome } = await usersRepository.setClientSmsConsent({
        userId: session.user.id,
        optedIn,
      });
      if (outcome === 'phone_not_verified') return { ok: false, code: 'phone_not_verified' };
      if (outcome === 'changed') {
        log.info('Client SMS consent changed', { userId: session.user.id, optedIn, surface });
      }
      return { ok: true };
    } catch (error) {
      log.error('Failed to change client SMS consent', {
        userId: session.user.id,
        optedIn,
        surface,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return { ok: false, code: 'request_failed' };
    }
  }
);
