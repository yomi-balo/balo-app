'use server';
import 'server-only';

import { z } from 'zod';
import { isAccountRefusalCode } from '@balo/shared/authz';
import { withAuth } from '@/lib/auth/with-auth';
import { resolveApprovedExpert, APPROVED_EXPERT_REQUIRED_ERROR } from '@/lib/auth/approved-expert';
import { isImpersonatedSession } from '@/lib/auth/impersonation';
import { SESSION_EXPIRED_MESSAGE } from '@/lib/auth/auth-error-copy';
import { getBaloApiJson, isExpiredCredentialFailure } from '@/lib/api/balo-api-client';
import { log } from '@/lib/logging';
import type { NormalizedField } from '../_components/payouts-tab';

/** Mirrors `apps/api`'s payout schema `querySchema` (routes/payouts/schema.ts). */
const inputSchema = z.object({
  country: z.string().length(2),
  currency: z.string().length(3).optional(),
  method: z.enum(['LOCAL', 'SWIFT']).optional(),
  entityType: z.enum(['PERSONAL', 'COMPANY']).optional(),
});

export interface GetPayoutFormSchemaInput {
  country: string;
  currency?: string;
  method?: 'LOCAL' | 'SWIFT';
  entityType?: 'PERSONAL' | 'COMPANY';
}

export type PayoutFormSchemaFailureCode =
  | 'not_approved_expert'
  | 'impersonation_refused'
  | 'invalid_request'
  | 'unsupported'
  | 'session_expired'
  | 'request_failed';

export type GetPayoutFormSchemaResult =
  | { ok: true; fields: NormalizedField[]; hiddenDefaults: Record<string, string> }
  | { ok: false; code: PayoutFormSchemaFailureCode; error: string };

const GENERIC_ERROR = "We couldn't load the bank details form. Please try again.";

const ERROR_COPY: Record<PayoutFormSchemaFailureCode, string> = {
  not_approved_expert: APPROVED_EXPERT_REQUIRED_ERROR,
  impersonation_refused: "Bank details can't be loaded while you're viewing as this expert.",
  invalid_request: GENERIC_ERROR,
  unsupported: "Payouts aren't available for this country and currency yet.",
  session_expired: SESSION_EXPIRED_MESSAGE,
  request_failed: GENERIC_ERROR,
};

function failure(code: PayoutFormSchemaFailureCode): GetPayoutFormSchemaResult {
  return { ok: false, code, error: ERROR_COPY[code] };
}

interface SchemaBody {
  fields: NormalizedField[];
  hiddenDefaults: Record<string, string>;
}

function parseSchemaBody(body: Record<string, unknown>): SchemaBody | null {
  if (!Array.isArray(body.fields)) return null;
  const hiddenDefaults: Record<string, string> = {};
  const raw = body.hiddenDefaults;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === 'string') hiddenDefaults[key] = value;
    }
  }
  return { fields: body.fields as NormalizedField[], hiddenDefaults };
}

function failureCodeFor(status: number, code: string): PayoutFormSchemaFailureCode {
  if (isAccountRefusalCode(code)) return 'request_failed';
  if (isExpiredCredentialFailure(status, code)) return 'session_expired';
  if (status === 400) return 'unsupported';
  return 'request_failed';
}

export const getPayoutFormSchemaAction = withAuth(
  async (session, input: GetPayoutFormSchemaInput): Promise<GetPayoutFormSchemaResult> => {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return failure('invalid_request');
    const { country, currency, method, entityType } = parsed.data;

    try {
      const gate = await resolveApprovedExpert(session.user);
      if (!gate.ok) return failure('not_approved_expert');

      if (isImpersonatedSession(session.user)) {
        log.warn('Payout form schema refused — impersonated session', {
          userId: session.user.id,
          impersonatorUserId: session.user.impersonatorUserId,
        });
        return failure('impersonation_refused');
      }

      const params = new URLSearchParams({ country });
      if (currency !== undefined) params.set('currency', currency);
      if (method !== undefined) params.set('method', method);
      if (entityType !== undefined) params.set('entity_type', entityType);

      const result = await getBaloApiJson(
        `/api/payouts/schema?${params.toString()}`,
        parseSchemaBody,
        'payout-form-schema'
      );
      if (!result.ok) return failure(failureCodeFor(result.status, result.code));
      return { ok: true, ...result.data };
    } catch (error) {
      log.error('Failed to load payout form schema', {
        userId: session.user.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return failure('request_failed');
    }
  }
);
