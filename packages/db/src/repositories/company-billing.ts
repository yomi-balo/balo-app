import { eq } from 'drizzle-orm';
import { db } from '../client';
import { companyBillingDetails, type CompanyBillingDetails } from '../schema';
// Direct relative import (NOT the ./index barrel, NOT '@balo/db/repositories') to
// avoid any import cycle. project-requests.ts must NOT import this file.
import { projectRequestsRepository } from './project-requests';

// ── Input types ──────────────────────────────────────────────────

interface UpsertCompanyBillingInput {
  companyId: string;
  legalName: string;
  countryCode: string; // char(2), e.g. 'AU'
  taxId?: string | null;
  address?: string | null;
  billingEmail: string;
  submittedByUserId: string;
}

// ── Repository ───────────────────────────────────────────────────

export const companyBillingRepository = {
  /**
   * Upsert the single current billing-identity record for a company. Whole-row
   * last-write-wins: every mutable column (including `submittedByUserId`, which
   * records who last wrote, and an explicit `updatedAt`) is in the `set` clause.
   * `companyId` is the conflict target and never mutated. Single atomic
   * INSERT … ON CONFLICT DO UPDATE — no read-then-write, no soft-delete.
   */
  async upsertByCompanyId(input: UpsertCompanyBillingInput): Promise<CompanyBillingDetails> {
    const [result] = await db
      .insert(companyBillingDetails)
      .values({
        companyId: input.companyId,
        legalName: input.legalName,
        countryCode: input.countryCode,
        taxId: input.taxId ?? null,
        address: input.address ?? null,
        billingEmail: input.billingEmail,
        submittedByUserId: input.submittedByUserId,
      })
      .onConflictDoUpdate({
        target: [companyBillingDetails.companyId],
        set: {
          legalName: input.legalName,
          countryCode: input.countryCode,
          taxId: input.taxId ?? null,
          address: input.address ?? null,
          billingEmail: input.billingEmail,
          submittedByUserId: input.submittedByUserId,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (result === undefined) {
      throw new Error('Failed to upsert company billing details');
    }
    return result;
  },

  /** Find the current billing details for a company (single current fact, no soft-delete). */
  async findByCompanyId(companyId: string): Promise<CompanyBillingDetails | undefined> {
    return db.query.companyBillingDetails.findFirst({
      where: eq(companyBillingDetails.companyId, companyId),
    });
  },
};

/**
 * Safe, idempotent primitive that auto-confirms a request's `client_billing`
 * kickoff gate ONLY when it is applicable, delegating the actual write to the
 * existing `projectRequestsRepository.confirmKickoffGate` (never modifying it).
 *
 * Never throws on a valid-but-not-ready request:
 *  1. Unknown / soft-deleted request → throw (fail loud on a bad/dead id).
 *  2. Gate already confirmed → no-op (checked BEFORE status, so a progressed
 *     request never trips the status guard).
 *  3. No billing captured for the company → no-op (nothing to auto-confirm).
 *  4. Request not yet `accepted` → no-op (mirrors confirmKickoffGate's own status
 *     guard so we never surface InvalidKickoffStateError).
 *  5. Applicable → delegate to the idempotent, FOR-UPDATE-locked gate confirmer.
 *
 * Import direction is one-way: this file imports `project-requests`, never the
 * reverse.
 */
export async function ensureClientBillingGateConfirmed(requestId: string): Promise<void> {
  const request = await projectRequestsRepository.findById(requestId);
  if (request === undefined) {
    throw new Error(`Project request not found: ${requestId}`);
  }

  if (request.clientBillingConfirmedAt !== null) {
    return;
  }

  const billing = await companyBillingRepository.findByCompanyId(request.companyId);
  if (billing === undefined) {
    return;
  }

  if (request.status !== 'accepted') {
    return;
  }

  await projectRequestsRepository.confirmKickoffGate({ id: requestId, gate: 'client_billing' });
}
