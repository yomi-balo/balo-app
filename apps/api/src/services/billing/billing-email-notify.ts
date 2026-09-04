import { usersRepository } from '@balo/db';
import { createLogger } from '@balo/shared/logging';
import { notificationEvents } from '../../notifications/publisher.js';

const log = createLogger('billing');

/**
 * BAL-522 — the ONE publisher for `billing.email_changed`. Mirrors
 * `services/credit/saved-card-notify.ts` verbatim in posture: BEST-EFFORT, NEVER THROWS. By the
 * time this is called, `companiesRepository.setBillingEmail`'s write + its audit row have ALREADY
 * committed — re-throwing would turn a completed settings change into a 500.
 */
export interface BillingEmailChangedNotice {
  companyId: string;
  newEmail: string;
  /** `null` on a first-ever explicit set (no prior value to notify). */
  previousEmail: string | null;
  changedByUserId: string;
  /** The `company.billing_email_changed` audit row id — the correlationId's dedup half. */
  dedupKey: string;
}

/**
 * ⚠ SECURITY GATE ON THE PREVIOUS-ADDRESS COURTESY NOTICE (fix round). `recipientEmail` is the
 * dispatcher's LITERAL delivery target, and `previousEmail` is whatever a MANAGE_BILLING holder
 * typed into the field on the PREVIOUS save — an arbitrary, unverified string. Passing it
 * through bare turns this settings form into an unrate-limited outbound-email primitive with
 * attacker-controlled company and actor names in the copy, and personal workspaces make
 * MANAGE_BILLING free to obtain. The ticket always scoped this notice to "the previous address's
 * USER, when it belongs to a current or former member", so resolve it: only an address that
 * `usersRepository.findByEmail` maps to a live Balo user is ever mailed.
 *
 * FAIL CLOSED. A lookup fault omits BOTH keys rather than mailing on an unproven address — the
 * change itself is already durable and audited, and this notice is a courtesy, not a record.
 *
 * ⚠ BOTH KEYS MOVE TOGETHER. `previousEmail` (template copy) and `recipientEmail` (the target)
 * are set together or not at all; the previous-address rule's condition keys off their presence,
 * so a half-set pair would either mail with no copy or render copy at nobody.
 */
async function resolvePreviousAddressKeys(
  n: BillingEmailChangedNotice
): Promise<{ previousEmail: string; recipientEmail: string } | Record<string, never>> {
  if (n.previousEmail === null) return {};
  try {
    const previousUser = await usersRepository.findByEmail(n.previousEmail);
    if (previousUser === undefined) {
      log.info(
        { op: 'publishBillingEmailChanged', companyId: n.companyId },
        'The previous billing address belongs to no Balo user — skipping the previous-address notice'
      );
      return {};
    }
    return { previousEmail: n.previousEmail, recipientEmail: n.previousEmail };
  } catch (err: unknown) {
    log.warn(
      {
        op: 'publishBillingEmailChanged',
        companyId: n.companyId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Could not resolve the previous billing address to a user — skipping the previous-address notice'
    );
    return {};
  }
}

/**
 * Best-effort publish of `billing.email_changed`. NEVER throws — the write is already durable;
 * a notification hiccup must not surface as a failure of the settings save.
 */
export async function publishBillingEmailChanged(n: BillingEmailChangedNotice): Promise<void> {
  // ⚠ `.`-JOINED, NEVER `:`-JOINED (memory `reference_bullmq_jobid_colon_rejected`).
  // `engine/dispatcher.ts` builds the per-CHANNEL BullMQ jobId from the RAW correlationId with NO
  // escape, and BullMQ throws unless the colon count is exactly 0 or 2. UUIDs never contain a
  // `.`, so this join is colon-free by construction regardless of what the parts turn out to be.
  const correlationId = `billing-email-changed.${n.companyId}.${n.dedupKey}`;
  try {
    // BOTH set together, or neither — see `resolvePreviousAddressKeys`. Absent together on a
    // first-ever set AND on an address that belongs to no user, so the previous-address rule's
    // condition never fires for either.
    const previousAddressKeys = await resolvePreviousAddressKeys(n);
    await notificationEvents.publish('billing.email_changed', {
      correlationId,
      companyId: n.companyId,
      newEmail: n.newEmail,
      changedByUserId: n.changedByUserId,
      ...previousAddressKeys,
    });
  } catch (err: unknown) {
    log.error(
      {
        op: 'publishBillingEmailChanged',
        correlationId,
        companyId: n.companyId,
        error: err instanceof Error ? err.message : String(err),
      },
      'Failed to publish billing.email_changed (the change is already committed; notification best-effort)'
    );
  }
}
