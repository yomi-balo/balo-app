import { companiesRepository, creditWalletsRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { trackServer, BILLING_SERVER_EVENTS } from '@balo/analytics/server';
import { syncStripeCustomerIdentity } from '../stripe/index.js';
import { publishBillingEmailChanged } from './billing-email-notify.js';

const log = createLogger('billing');

export type SetCompanyBillingEmailResult =
  | { status: 'updated'; billingEmail: string; setAt: Date }
  | { status: 'unchanged'; billingEmail: string; setAt: Date | null }
  | { status: 'forbidden' }
  | { status: 'not_found' };

/** Whole days between `from` and `to`; `null` when `from` is null (nothing to measure). */
function daysBetween(from: Date | null, to: Date): number | null {
  if (from === null) return null;
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * BAL-522 — the orchestration for an EXPLICIT billing-email change from `/settings/billing`.
 * The route (`routes/credit/billing-email.ts`) is a thin controller; this is where the write
 * result fans out to the Stripe sync, the notification and the analytics event.
 *
 * Order:
 *  1. `companiesRepository.setBillingEmail` — the ONE transaction that writes the value, the
 *     attribution and the audit row (D4: the TOCTOU-safe MANAGE_BILLING gate lives INSIDE it). A
 *     genuine DB fault propagates — the route 500s.
 *  2. `not_found` / `forbidden` ⇒ return immediately. No sync, no publish, no analytics.
 *  3. SYNC (decision 4 — "on every touch"), for BOTH `changed` and `unchanged`: idempotent by
 *     value, and it heals a Customer whose identity drifted since the last `ensureCustomer`
 *     touch. No wallet, or a wallet with no Customer yet, ⇒ nothing to sync (the next
 *     `ensureCustomer` touch covers it).
 *  4. `unchanged` ⇒ return. No audit (already skipped in the repository), no notification, no
 *     analytics — nobody changed anything.
 *  5. `changed` ⇒ log, `trackServer`, `publishBillingEmailChanged` (best-effort internally, AND
 *     wrapped here — see the comment at the call site), then return.
 */
export async function setCompanyBillingEmail(input: {
  companyId: string;
  actorUserId: string;
  billingEmail: string;
}): Promise<SetCompanyBillingEmailResult> {
  const { companyId, actorUserId, billingEmail } = input;

  const result = await companiesRepository.setBillingEmail({
    companyId,
    actorUserId,
    billingEmail,
  });

  if (result.outcome === 'not_found') {
    return { status: 'not_found' };
  }
  if (result.outcome === 'forbidden') {
    return { status: 'forbidden' };
  }

  // Step 3 — sync on EVERY touch, for both `changed` and `unchanged`.
  const wallet = await creditWalletsRepository.findByCompanyId(companyId);
  if (wallet?.stripeCustomerId == null) {
    log.debug(
      { op: 'setCompanyBillingEmail', companyId, actorUserId },
      'No Stripe customer for this company yet — the identity sync will run on the next touch'
    );
  } else {
    await syncStripeCustomerIdentity(wallet.stripeCustomerId, {
      name: result.company.name,
      email: result.billingEmail,
    });
  }

  if (result.outcome === 'unchanged') {
    return { status: 'unchanged', billingEmail: result.billingEmail, setAt: result.setAt };
  }

  log.info(
    {
      op: 'setCompanyBillingEmail',
      companyId,
      actorUserId,
      hadPrevious: result.previousEmail !== null,
    },
    'Company billing email updated'
  );

  trackServer(BILLING_SERVER_EVENTS.EMAIL_UPDATED, {
    company_id: companyId,
    company_is_personal: result.company.isPersonal,
    previous_source: result.previousSource,
    days_since_set: daysBetween(result.previousSetAt, result.setAt),
    distinct_id: companyId,
  });

  // Step 5's publish is BELT AND BRACES. `publishBillingEmailChanged` already swallows its own
  // failures, but the write + the audit row committed back at step 1 — so a rejection reaching
  // here (a future regression in that module, a synchronous throw before its own try) must never
  // turn a completed settings change into a 500. Catch it here too, and log.
  try {
    await publishBillingEmailChanged({
      companyId,
      newEmail: result.billingEmail,
      previousEmail: result.previousEmail,
      changedByUserId: actorUserId,
      dedupKey: result.auditEventId,
    });
  } catch (err: unknown) {
    log.error(
      {
        op: 'setCompanyBillingEmail',
        companyId,
        actorUserId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to publish billing.email_changed (the change is already committed; notification best-effort)'
    );
  }

  return { status: 'updated', billingEmail: result.billingEmail, setAt: result.setAt };
}
