/**
 * Expert Bank Details
 *
 * Collect BSB + account number from experts for future manual payouts.
 * Details are encrypted at rest. Admin verifies before first payout.
 *
 * This is the data layer for BAL-196 (Payouts settings tab).
 */

import { db } from '@balo/db';
import { expertBankDetails } from '@balo/db/schema';
import { eq } from 'drizzle-orm';
import { encrypt, decrypt } from '@balo/api/lib/encryption';

export interface BankDetailsInput {
  expertUserId: string;
  bankName: string;       // e.g. "Commonwealth Bank"
  bsb: string;            // 6 digits, no dash, e.g. "062000"
  accountNumber: string;  // 6–10 digits
  accountName: string;    // Name on account
}

export interface BankDetailsResult {
  id: string;
  bankName: string;
  bsb: string;            // Always returned as-is (not sensitive)
  accountNumberLast4: string; // Masked for display
  accountName: string;
  verifiedAt: Date | null;
  updatedAt: Date;
}

/**
 * Save or update expert bank details.
 * Encrypts account number before storage.
 * One record per expert — upserts on expertUserId.
 */
export async function saveExpertBankDetails(
  input: BankDetailsInput
): Promise<void> {
  // Validate AU BSB format
  if (!/^\d{6}$/.test(input.bsb)) {
    throw new Error('BSB must be exactly 6 digits');
  }
  if (!/^\d{6,10}$/.test(input.accountNumber)) {
    throw new Error('Account number must be 6–10 digits');
  }

  const encryptedAccountNumber = await encrypt(input.accountNumber);

  await db
    .insert(expertBankDetails)
    .values({
      expertUserId: input.expertUserId,
      bankName: input.bankName,
      bsb: input.bsb,
      accountNumberEncrypted: encryptedAccountNumber,
      accountName: input.accountName,
      verifiedAt: null, // Admin sets this after manual verification
    })
    .onConflictDoUpdate({
      target: expertBankDetails.expertUserId,
      set: {
        bankName: input.bankName,
        bsb: input.bsb,
        accountNumberEncrypted: encryptedAccountNumber,
        accountName: input.accountName,
        verifiedAt: null, // Reset verification when details change
        updatedAt: new Date(),
      },
    });
}

/**
 * Get bank details for display (masked account number).
 * Never returns the full account number to the frontend.
 */
export async function getExpertBankDetailsForDisplay(
  expertUserId: string
): Promise<BankDetailsResult | null> {
  const [row] = await db
    .select()
    .from(expertBankDetails)
    .where(eq(expertBankDetails.expertUserId, expertUserId))
    .limit(1);

  if (!row) return null;

  const decrypted = await decrypt(row.accountNumberEncrypted);

  return {
    id: row.id,
    bankName: row.bankName,
    bsb: row.bsb,
    accountNumberLast4: `••••${decrypted.slice(-4)}`,
    accountName: row.accountName,
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
  };
}
