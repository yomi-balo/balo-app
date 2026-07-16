'use server';

import 'server-only';

import { creditWalletsRepository } from '@balo/db';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';

/**
 * The serialisable result of starting the continue-to-mandate flow. `ready` carries the
 * SetupIntent client secret + the Stripe publishable key the browser needs to mount
 * Elements; `already_active` short-circuits when a mandate is already captured (no
 * duplicate SetupIntent); `forbidden` / `unconfigured` / `error` are warm terminal states
 * the panel renders without leaking detail.
 */
export type StartContinueToMandateResult =
  | { status: 'ready'; clientSecret: string; publishableKey: string }
  | { status: 'already_active' }
  | { status: 'forbidden' }
  | { status: 'unconfigured' }
  | { status: 'error' };

function getApiUrl(): string {
  const url = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL;
  if (!url) {
    log.warn('API_URL not configured — falling back to localhost:3002');
    return 'http://localhost:3002';
  }
  return url;
}

/**
 * Begin the Model-C continue-to-mandate flow (BAL-383). Gated on `MANAGE_BILLING` for the
 * session company. Resolves the company wallet; if a mandate is already `active`, returns
 * early (no duplicate SetupIntent). Otherwise it calls the internal
 * `POST /stripe/setup-intent` seam (`createSetupIntent`, BAL-382) over the internal-auth
 * HTTP hop and returns the `client_secret` + publishable key for the browser to confirm
 * the card. Mandate persistence is unchanged — the BAL-382 `setup_intent.succeeded`
 * webhook writes it; this action captures NO mandate state.
 */
export async function startContinueToMandate(): Promise<StartContinueToMandateResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { status: 'forbidden' };
  }

  const allowed = await hasCapability(user, CAPABILITIES.MANAGE_BILLING, {
    companyId: user.companyId,
  });
  if (!allowed) {
    return { status: 'forbidden' };
  }

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  const secret = process.env.INTERNAL_API_SECRET;
  if (!publishableKey || !secret) {
    log.error('Continue-to-mandate is unconfigured (missing publishable key or internal secret)', {
      companyId: user.companyId,
    });
    return { status: 'unconfigured' };
  }

  try {
    const wallet = await creditWalletsRepository.findByCompanyId(user.companyId);
    if (wallet === undefined) {
      // A wallet is materialised on the first redeem, so the continue prompt should never
      // reach here without one — treat a missing wallet as a soft error, not a crash.
      log.warn('Continue-to-mandate found no wallet for company', { companyId: user.companyId });
      return { status: 'error' };
    }
    if (wallet.mandateStatus === 'active') {
      return { status: 'already_active' };
    }

    const response = await loggedFetch(`${getApiUrl()}/stripe/setup-intent`, {
      service: 'balo-api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': secret,
      },
      body: JSON.stringify({ walletId: wallet.id }),
    });

    if (!response.ok) {
      log.error('Continue-to-mandate setup-intent request failed', {
        companyId: user.companyId,
        status: response.status,
      });
      return { status: 'error' };
    }

    const body = (await response.json()) as { clientSecret?: unknown };
    if (typeof body.clientSecret !== 'string' || body.clientSecret.length === 0) {
      log.error('Continue-to-mandate setup-intent returned no clientSecret', {
        companyId: user.companyId,
      });
      return { status: 'error' };
    }

    return { status: 'ready', clientSecret: body.clientSecret, publishableKey };
  } catch (error) {
    log.error('Continue-to-mandate failed', {
      companyId: user.companyId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { status: 'error' };
  }
}
