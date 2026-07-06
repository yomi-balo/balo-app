// Shared billing-details field schema (BAL-323) — imported by BOTH the client form
// (react-hook-form zodResolver) and the `submit-billing-details` Server Action
// (validate-before-write, house convention). No 'use server' here: this is a plain
// module so the client bundle can pull the schema for inline validation.
//
// Only the raw `taxId` string and ISO `countryCode` are persisted — the country →
// tax-ID label mapping is presentational (see lib/billing/tax-id-labels).

import { z } from 'zod';

export const BILLING_LEGAL_NAME_MAX = 200;
export const BILLING_TAX_ID_MAX = 60;
export const BILLING_ADDRESS_MAX = 500;
export const BILLING_EMAIL_MAX = 200;

export const billingDetailsSchema = z.object({
  legalName: z
    .string()
    .trim()
    .min(1, 'Enter your legal or entity name')
    .max(BILLING_LEGAL_NAME_MAX, 'That name is too long'),
  // ISO 3166-1 alpha-2, uppercase — the <Select> only ever emits valid codes; this
  // guards a hand-crafted request. Country membership is not enforced (a valid code
  // outside the curated list still persists, taking the fallback tax-ID label).
  countryCode: z
    .string()
    .trim()
    .regex(/^[A-Z]{2}$/, 'Select a country'),
  taxId: z
    .string()
    .trim()
    .min(1, 'Enter your business tax ID')
    .max(BILLING_TAX_ID_MAX, 'That tax ID is too long'),
  // Optional (the only optional field per BAL-323). Empty string is allowed and
  // normalised to null at the persistence boundary in the action.
  address: z.string().trim().max(BILLING_ADDRESS_MAX, 'That address is too long').optional(),
  billingEmail: z
    .string()
    .trim()
    .min(1, 'Enter a billing email')
    .email('Enter a valid email')
    .max(BILLING_EMAIL_MAX, 'That email is too long'),
});

export type BillingDetailsInput = z.infer<typeof billingDetailsSchema>;
