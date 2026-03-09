'use server';
import 'server-only';

import crypto from 'crypto';
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withAuth } from '@/lib/auth/with-auth';
import { payoutsRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { loggedFetch } from '@/lib/logging/fetch-wrapper';

// ── Sensitive field paths ───────────────────────────────────────

const SENSITIVE_PATHS = new Set([
  'beneficiary.bank_details.account_number',
  'beneficiary.bank_details.iban',
  'beneficiary.bank_details.routing_number',
  'beneficiary.bank_details.sort_code',
  'beneficiary.bank_details.bsb_number',
]);

function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  if (value.length <= 8) return '*'.repeat(value.length - 2) + value.slice(-2);
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

function encryptValue(value: string): string {
  // AES-256-GCM encryption using PAYOUT_ENCRYPTION_KEY
  // TODO: BAL-203 — migrate to pgcrypto for at-rest encryption in Postgres
  const key = process.env.PAYOUT_ENCRYPTION_KEY;
  if (!key) {
    throw new Error('PAYOUT_ENCRYPTION_KEY is not configured');
  }
  // Derive a 32-byte key from the env var
  const derivedKey = crypto.createHash('sha256').update(key).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext (all base64)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

// ── Validation ──────────────────────────────────────────────────

const savePayoutDetailsSchema = z.object({
  countryCode: z.string().length(2, 'Country code must be 2 characters'),
  currency: z.string().length(3, 'Currency must be 3 characters'),
  transferMethod: z.string().min(1, 'Transfer method is required'),
  entityType: z.string().min(1, 'Entity type is required'),
  formValues: z
    .record(z.string(), z.string())
    .refine((val) => Object.keys(val).length > 0, 'Form values cannot be empty'),
});

// ── Types ───────────────────────────────────────────────────────

export interface SavePayoutDetailsInput {
  countryCode: string;
  currency: string;
  transferMethod: string;
  entityType: string;
  formValues: Record<string, string>;
}

export interface SavePayoutDetailsResult {
  success: boolean;
  error?: string;
  maskedFormValues?: Record<string, string>;
  beneficiaryStatus?: 'verified' | 'pending_verification' | 'invalid';
  airwallexFieldErrors?: Record<string, string>;
}

// ── Action ──────────────────────────────────────────────────────

export const savePayoutDetailsAction = withAuth(
  async (session, input: SavePayoutDetailsInput): Promise<SavePayoutDetailsResult> => {
    try {
      // 1. Validate input
      const validated = savePayoutDetailsSchema.parse(input);

      // 2. Verify expert mode
      if (session.user.activeMode !== 'expert' || !session.user.expertProfileId) {
        return { success: false, error: 'Expert profile required' };
      }

      const expertProfileId = session.user.expertProfileId;

      // 3. Check if this is an update (details already exist)
      const existing = await payoutsRepository.findByExpertProfileId(expertProfileId);
      const isUpdate = !!existing;

      // 4. Process form values — mask sensitive fields, encrypt originals
      const maskedFormValues: Record<string, string> = {};
      let encryptedAccountNumber: string | null = null;
      let encryptedIban: string | null = null;
      let encryptedRoutingNumber: string | null = null;

      for (const [path, value] of Object.entries(validated.formValues)) {
        if (!value) continue;

        if (SENSITIVE_PATHS.has(path)) {
          // Store masked value in formValues
          maskedFormValues[path] = maskValue(value);

          // Encrypt and store in dedicated columns
          if (path === 'beneficiary.bank_details.account_number') {
            encryptedAccountNumber = encryptValue(value);
          } else if (path === 'beneficiary.bank_details.iban') {
            encryptedIban = encryptValue(value);
          } else if (
            path === 'beneficiary.bank_details.routing_number' ||
            path === 'beneficiary.bank_details.sort_code' ||
            path === 'beneficiary.bank_details.bsb_number'
          ) {
            encryptedRoutingNumber = encryptValue(value);
          }
        } else {
          maskedFormValues[path] = value;
        }
      }

      // 5. Persist to database
      await payoutsRepository.upsertPayoutDetails(expertProfileId, {
        countryCode: validated.countryCode,
        currency: validated.currency,
        transferMethod: validated.transferMethod,
        entityType: validated.entityType,
        formValues: maskedFormValues,
        encryptedAccountNumber,
        encryptedIban,
        encryptedRoutingNumber,
      });

      if (isUpdate) {
        log.info('Expert payout details updated', {
          expertProfileId,
          userId: session.user.id,
          countryCode: validated.countryCode,
          transferMethod: validated.transferMethod,
        });
      } else {
        log.info('Expert payout details saved', {
          expertProfileId,
          userId: session.user.id,
          countryCode: validated.countryCode,
          transferMethod: validated.transferMethod,
        });
      }

      // 6. Call Fastify API for Airwallex beneficiary registration
      const apiUrl =
        process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';
      const internalSecret = process.env.INTERNAL_API_SECRET;

      let beneficiaryStatus: 'verified' | 'pending_verification' | 'invalid' =
        'pending_verification';
      let airwallexFieldErrors: Record<string, string> | undefined;

      if (!internalSecret) {
        log.error('INTERNAL_API_SECRET is not configured — cannot register beneficiary', {
          expertProfileId,
        });

        await payoutsRepository.updateBeneficiaryStatus(expertProfileId, {
          beneficiaryStatus: 'pending_verification',
        });

        revalidatePath('/expert/settings');
        return { success: true, maskedFormValues, beneficiaryStatus: 'pending_verification' };
      }

      try {
        const beneficiaryRes = await loggedFetch(`${apiUrl}/api/payouts/beneficiary`, {
          service: 'balo-api',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-api-key': internalSecret ?? '',
          },
          body: JSON.stringify({
            expertProfileId,
            expertName:
              [session.user.firstName, session.user.lastName].filter(Boolean).join(' ') || 'Expert',
          }),
        });

        const beneficiaryData = (await beneficiaryRes.json()) as {
          success?: boolean;
          beneficiaryStatus?: 'verified' | 'pending_verification' | 'invalid';
          airwallexFieldErrors?: Record<string, string>;
        };

        beneficiaryStatus = beneficiaryData.beneficiaryStatus ?? 'pending_verification';

        // 7. Handle response — three cases
        if (beneficiaryRes.ok && beneficiaryData.success) {
          // Airwallex verified
          beneficiaryStatus = 'verified';
        } else if (beneficiaryRes.status === 422) {
          // Airwallex 4xx validation error
          airwallexFieldErrors = beneficiaryData.airwallexFieldErrors;
          beneficiaryStatus = 'invalid';

          // Revalidate so page picks up the new payout details (even though invalid)
          revalidatePath('/expert/settings');

          return {
            success: false,
            airwallexFieldErrors,
            beneficiaryStatus: 'invalid',
          };
        }
        // 202 (pending_verification) falls through to success path
      } catch (fetchError) {
        // Fastify unreachable — update DB directly to pending_verification
        log.warn('Fastify beneficiary endpoint unreachable — marking pending_verification', {
          expertProfileId,
          error: fetchError instanceof Error ? fetchError.message : String(fetchError),
        });

        try {
          await payoutsRepository.updateBeneficiaryStatus(expertProfileId, {
            beneficiaryStatus: 'pending_verification',
          });
        } catch (dbErr) {
          log.error('Failed to update beneficiary status after Fastify failure', {
            expertProfileId,
            error: dbErr instanceof Error ? dbErr.message : String(dbErr),
          });
        }

        beneficiaryStatus = 'pending_verification';
      }

      // 8. Revalidate the settings page so checklist picks up the new payout details
      revalidatePath('/expert/settings');

      return { success: true, maskedFormValues, beneficiaryStatus };
    } catch (error) {
      log.error('Failed to save payout details', {
        userId: session.user.id,
        expertProfileId: session.user.expertProfileId,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (error instanceof z.ZodError) {
        return { success: false, error: error.issues[0]?.message ?? 'Invalid input' };
      }

      return { success: false, error: 'Failed to save payout details. Please try again.' };
    }
  }
);
