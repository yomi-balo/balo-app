import lodash from 'lodash';
const { set } = lodash;
import type { ExpertPayoutDetails } from '@balo/db';
import { decryptValue } from '../../lib/encryption.js';
import { airwallexRequest } from './client.js';
import { AirwallexApiError } from './errors.js';

// ── Types ───────────────────────────────────────────────────────

interface CreateBeneficiaryRequest {
  nickname: string;
  payer_entity_type: 'COMPANY';
  transfer_methods: string[];
  beneficiary: Record<string, unknown>;
}

interface AirwallexBeneficiaryResponse {
  id: string;
}

interface AirwallexErrorDetail {
  field?: string;
  message?: string;
}

export type RegisterResult =
  | { success: true; beneficiaryId: string }
  | {
      success: false;
      isValidationError: boolean;
      fieldErrors: Record<string, string>;
      error: string;
    };

// ── buildBeneficiaryPayload ─────────────────────────────────────

/** Only paths under these prefixes are allowed through to the Airwallex payload. */
const ALLOWED_PATH_PREFIXES = ['beneficiary.'] as const;

/**
 * Converts flat dot-notation form paths to the nested Airwallex object.
 * Sets `transfer_methods` as an array before the loop and skips the `transfer_method` path.
 * Validates paths against an allowlist to prevent payload manipulation.
 */
export function buildBeneficiaryPayload(
  formValues: Record<string, string>,
  expertName: string
): CreateBeneficiaryRequest {
  const transferMethod = formValues['transfer_method'] ?? 'LOCAL';

  const payload: Record<string, unknown> = {
    nickname: expertName,
    payer_entity_type: 'COMPANY',
    transfer_methods: [transferMethod],
  };

  for (const [path, value] of Object.entries(formValues)) {
    if (!value) continue;
    if (path === 'transfer_method') continue; // already handled above
    // Only allow paths under known prefixes to prevent payload injection
    if (!ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    set(payload, path, value);
  }

  return payload as unknown as CreateBeneficiaryRequest;
}

// ── reconstructFormValues ───────────────────────────────────────

/**
 * Takes ExpertPayoutDetails from DB and replaces masked values
 * with decrypted originals from the encrypted columns.
 */
export function reconstructFormValues(details: ExpertPayoutDetails): Record<string, string> {
  const formValues = { ...(details.formValues as Record<string, string>) };

  // Restore encrypted account number
  if (details.encryptedAccountNumber) {
    formValues['beneficiary.bank_details.account_number'] = decryptValue(
      details.encryptedAccountNumber
    );
  }

  // Restore encrypted IBAN
  if (details.encryptedIban) {
    formValues['beneficiary.bank_details.iban'] = decryptValue(details.encryptedIban);
  }

  // Restore encrypted routing number (covers routing_number, sort_code, bsb_number)
  if (details.encryptedRoutingNumber) {
    const decrypted = decryptValue(details.encryptedRoutingNumber);

    // Determine which field path to use based on existing keys
    if ('beneficiary.bank_details.bsb_number' in formValues) {
      formValues['beneficiary.bank_details.bsb_number'] = decrypted;
    } else if ('beneficiary.bank_details.sort_code' in formValues) {
      formValues['beneficiary.bank_details.sort_code'] = decrypted;
    } else if ('beneficiary.bank_details.routing_number' in formValues) {
      formValues['beneficiary.bank_details.routing_number'] = decrypted;
    } else {
      // Fallback: determine from country code
      if (details.countryCode === 'AU') {
        formValues['beneficiary.bank_details.bsb_number'] = decrypted;
      } else if (details.countryCode === 'GB') {
        formValues['beneficiary.bank_details.sort_code'] = decrypted;
      } else {
        formValues['beneficiary.bank_details.routing_number'] = decrypted;
      }
    }
  }

  // Ensure transfer_method is present (needed by buildBeneficiaryPayload)
  if (!formValues['transfer_method'] && details.transferMethod) {
    formValues['transfer_method'] = details.transferMethod;
  }

  return formValues;
}

// ── registerBeneficiary ─────────────────────────────────────────

/**
 * Calls Airwallex POST /beneficiaries/create with idempotency key.
 * Returns a discriminated union — success or failure with parsed field errors.
 */
export async function registerBeneficiary(
  formValues: Record<string, string>,
  expertName: string,
  expertProfileId: string,
  updatedAtMs: number
): Promise<RegisterResult> {
  const payload = buildBeneficiaryPayload(formValues, expertName);
  const idempotencyKey = `balo-beneficiary-${expertProfileId}-${updatedAtMs}`;

  try {
    const result = await airwallexRequest<AirwallexBeneficiaryResponse>(
      'POST',
      '/beneficiaries/create',
      payload,
      { idempotencyKey }
    );

    return { success: true, beneficiaryId: result.id };
  } catch (err: unknown) {
    if (err instanceof AirwallexApiError) {
      const is4xx = err.status >= 400 && err.status < 500;

      // Parse field-level validation errors from Airwallex response
      const fieldErrors: Record<string, string> = {};
      let parsedDetails: AirwallexErrorDetail[] = [];

      try {
        const body = JSON.parse(err.detail) as {
          details?: AirwallexErrorDetail[];
          message?: string;
        };
        parsedDetails = body.details ?? [];
      } catch {
        // detail is not JSON — use the raw string as the error message
      }

      for (const d of parsedDetails) {
        if (d.field && d.message) {
          fieldErrors[d.field] = d.message;
        }
      }

      if (is4xx) {
        return {
          success: false,
          isValidationError: true,
          fieldErrors,
          error: err.message,
        };
      }

      // 5xx — re-throw so caller can decide (retry / enqueue)
      throw err;
    }

    throw err;
  }
}
