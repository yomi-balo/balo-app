import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../client';
import { expertPayoutDetails, type ExpertPayoutDetails } from '../schema';

// ── Input types ──────────────────────────────────────────────────

interface UpsertPayoutInput {
  countryCode: string;
  currency: string;
  transferMethod: string;
  entityType: string;
  formValues: Record<string, string>;
  encryptedAccountNumber?: string | null;
  encryptedIban?: string | null;
  encryptedRoutingNumber?: string | null;
}

// ── Repository ───────────────────────────────────────────────────

export const payoutsRepository = {
  /** Find payout details by expert profile ID */
  async findByExpertProfileId(expertProfileId: string): Promise<ExpertPayoutDetails | undefined> {
    return db.query.expertPayoutDetails.findFirst({
      where: and(
        eq(expertPayoutDetails.expertProfileId, expertProfileId),
        isNull(expertPayoutDetails.deletedAt)
      ),
    });
  },

  /** Upsert payout details. Resets verifiedAt to null on every save. */
  async upsertPayoutDetails(
    expertProfileId: string,
    data: UpsertPayoutInput
  ): Promise<ExpertPayoutDetails> {
    const [result] = await db
      .insert(expertPayoutDetails)
      .values({
        expertProfileId,
        countryCode: data.countryCode,
        currency: data.currency,
        transferMethod: data.transferMethod,
        entityType: data.entityType,
        formValues: data.formValues,
        encryptedAccountNumber: data.encryptedAccountNumber ?? null,
        encryptedIban: data.encryptedIban ?? null,
        encryptedRoutingNumber: data.encryptedRoutingNumber ?? null,
        verifiedAt: null,
        verifiedBy: null,
        airwallexBeneficiaryId: null,
        beneficiaryRegisteredAt: null,
        beneficiaryStatus: null,
      })
      .onConflictDoUpdate({
        target: [expertPayoutDetails.expertProfileId],
        set: {
          countryCode: data.countryCode,
          currency: data.currency,
          transferMethod: data.transferMethod,
          entityType: data.entityType,
          formValues: data.formValues,
          encryptedAccountNumber: data.encryptedAccountNumber ?? null,
          encryptedIban: data.encryptedIban ?? null,
          encryptedRoutingNumber: data.encryptedRoutingNumber ?? null,
          verifiedAt: null,
          verifiedBy: null,
          airwallexBeneficiaryId: null,
          beneficiaryRegisteredAt: null,
          beneficiaryStatus: null,
          updatedAt: new Date(),
          deletedAt: null,
        },
      })
      .returning();

    return result!;
  },

  /** Update Airwallex beneficiary status for an expert's payout details */
  async updateBeneficiaryStatus(
    expertProfileId: string,
    data: {
      airwallexBeneficiaryId?: string;
      beneficiaryStatus: 'verified' | 'pending_verification' | 'invalid';
      beneficiaryRegisteredAt?: Date;
    }
  ): Promise<void> {
    await db
      .update(expertPayoutDetails)
      .set({
        ...(data.airwallexBeneficiaryId !== undefined && {
          airwallexBeneficiaryId: data.airwallexBeneficiaryId,
        }),
        beneficiaryStatus: data.beneficiaryStatus,
        ...(data.beneficiaryRegisteredAt !== undefined && {
          beneficiaryRegisteredAt: data.beneficiaryRegisteredAt,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(expertPayoutDetails.expertProfileId, expertProfileId),
          isNull(expertPayoutDetails.deletedAt)
        )
      );
  },

  /** Check if payout details exist (for checklist) */
  async hasPayoutDetails(expertProfileId: string): Promise<boolean> {
    const row = await db.query.expertPayoutDetails.findFirst({
      where: and(
        eq(expertPayoutDetails.expertProfileId, expertProfileId),
        isNull(expertPayoutDetails.deletedAt)
      ),
      columns: { id: true },
    });

    return !!row;
  },
};
