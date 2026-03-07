/**
 * Schema types for Balo's payment ledger tables
 */

// ── Credit Transactions (client side) ───────────────────────────

export type CreditTransactionType =
  | 'purchase'     // Client bought credits via Stripe Checkout
  | 'consumption'  // Credits deducted during a consultation
  | 'refund'       // Credits returned due to refund or dispute
  | 'promo'        // Promotional credits added by admin
  | 'expiry'       // Expired unused credits
  | 'adjustment';  // Manual adjustment by admin

export interface CreditTransaction {
  id: string;
  userId: string;                    // client user ID
  type: CreditTransactionType;
  credits: number;                   // positive = added, negative = deducted
  amountCents: number | null;        // AUD cents (only for purchase/refund)
  stripePaymentId: string | null;    // Stripe session/payment ID (purchase only)
  consultationId: string | null;     // Linked consultation (consumption only)
  description: string;
  createdAt: Date;
}

// ── Expert Earnings (expert side) ───────────────────────────────

export type ExpertEarningsStatus =
  | 'pending'    // Consultation complete, not yet reviewed
  | 'approved'   // Admin approved, ready for payout
  | 'paid'       // Included in a payout batch
  | 'disputed';  // Flagged due to client dispute

export interface ExpertEarnings {
  id: string;
  consultationId: string;
  expertUserId: string;
  clientUserId: string;
  durationMinutes: number;
  creditsConsumed: number;
  grossAmountCents: number;    // What client paid
  platformFeeCents: number;    // Balo's 25% cut
  netAmountCents: number;      // What expert earns (gross - fee)
  status: ExpertEarningsStatus;
  payoutId: string | null;     // Set when included in a payout batch (post-MVP)
  createdAt: Date;
  updatedAt: Date;
}

// ── Expert Bank Details ──────────────────────────────────────────

export interface ExpertBankDetails {
  id: string;
  expertUserId: string;
  bankName: string;
  bsb: string;                         // 6 digits, AU format
  accountNumberEncrypted: string;      // Encrypted at rest
  accountName: string;
  verifiedAt: Date | null;             // Set by admin after manual verification
  createdAt: Date;
  updatedAt: Date;
}
