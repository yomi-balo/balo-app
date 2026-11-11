import type { FastifyInstance } from 'fastify';
import * as Sentry from '@sentry/node';
import { z } from 'zod';
import { requireAuth } from '../../lib/require-auth.js';
import { createRateLimitPreHandler } from '../../lib/rate-limit-prehandler.js';
import { airwallexRequest } from '../../services/airwallex/client.js';
import {
  AirwallexApiError,
  AirwallexAuthError,
  truncateAirwallexDetail,
} from '../../services/airwallex/errors.js';

// ── Types ───────────────────────────────────────────────────────

interface FormSchemaField {
  path: string;
  required: boolean;
  enabled: boolean;
  rule?: { type: string; pattern?: string };
  field: {
    key: string;
    label: string;
    description?: string;
    placeholder?: string;
    tip?: string;
    type: string;
    options?: Array<{ label: string; value: string }>;
    default?: string;
    refresh?: boolean;
  };
}

interface AirwallexSchemaResponse {
  fields: FormSchemaField[];
  condition: Record<string, unknown>;
}

export interface NormalizedField {
  path: string;
  required: boolean;
  label: string;
  description?: string;
  placeholder?: string;
  tip?: string;
  type: 'text' | 'enum';
  options?: Array<{ label: string; value: string }>;
  defaultValue?: string;
  refresh: boolean;
  validation?: { pattern: string };
  wide?: boolean;
}

// ── Validation ──────────────────────────────────────────────────

const querySchema = z.object({
  country: z.string().length(2, 'country must be a 2-letter ISO code'),
  method: z.enum(['LOCAL', 'SWIFT']).default('LOCAL'),
  currency: z.string().length(3, 'currency must be a 3-letter ISO code').optional(),
  entity_type: z.enum(['PERSONAL', 'COMPANY']).default('COMPANY'),
});

// Fields that should span full width
const WIDE_FIELD_KEYS = new Set([
  'beneficiary.bank_details.account_name',
  'beneficiary.address.street_address',
  'beneficiary.company_name',
]);

/**
 * Paths Balo fixes to the schema's own default: never offered to the expert, always sent in the
 * save payload. The payout rail (`local_clearing_system`) is Balo's choice, not the expert's.
 */
const FORCED_DEFAULT_PATHS = new Set(['beneficiary.bank_details.local_clearing_system']);

function normalizeField(f: FormSchemaField): NormalizedField {
  const isChoice = f.field.type === 'SELECT' || f.field.type === 'RADIO';
  return {
    path: f.path,
    required: f.required,
    label: f.field.label,
    description: f.field.description,
    placeholder: f.field.placeholder,
    tip: f.field.tip,
    type: isChoice ? 'enum' : 'text',
    options: f.field.options,
    defaultValue: f.field.default,
    refresh: f.field.refresh ?? false,
    validation: f.rule?.pattern ? { pattern: f.rule.pattern } : undefined,
    wide: WIDE_FIELD_KEYS.has(f.path),
  };
}

/**
 * Disabled fields with a default value that must be included in the create
 * payload (e.g. account_routing_type1 = "bsb" for AU).
 */
function collectHiddenDefaults(fields: FormSchemaField[]): Record<string, string> {
  const hiddenDefaults: Record<string, string> = {};
  for (const f of fields) {
    if (f.field.default && ((!f.enabled && f.required) || FORCED_DEFAULT_PATHS.has(f.path))) {
      hiddenDefaults[f.path] = f.field.default;
    }
  }
  return hiddenDefaults;
}

// ── Route ───────────────────────────────────────────────────────

// failOpen: a miss costs a free Airwallex schema call, and a Redis outage must not take the Payouts form down.
const payoutSchemaRateLimit = createRateLimitPreHandler({
  config: { keyPrefix: 'ratelimit:payout-form-schema', maxRequests: 30, windowSeconds: 60 },
  failOpen: true,
  label: 'payout-form-schema',
  identifier: (request) => request.userId,
  logIdentifier: true,
});

export function schemaRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/api/payouts/schema',
    { preHandler: [requireAuth, payoutSchemaRateLimit] },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: parsed.error.issues.map((i: { message: string }) => i.message),
        });
      }

      const { country, method, currency, entity_type } = parsed.data;

      try {
        const schema = await airwallexRequest<AirwallexSchemaResponse>(
          'POST',
          '/beneficiary_form_schemas/generate',
          {
            bank_country_code: country,
            transfer_method: method,
            ...(currency ? { account_currency: currency } : {}),
            entity_type,
          }
        );

        const fields = schema.fields
          .filter((f) => f.enabled && !FORCED_DEFAULT_PATHS.has(f.path))
          .map(normalizeField);
        const hiddenDefaults = collectHiddenDefaults(schema.fields);

        return reply.send({ fields, hiddenDefaults, condition: schema.condition });
      } catch (err: unknown) {
        if (err instanceof AirwallexApiError && err.status === 400) {
          fastify.log.warn(
            { countryCode: country, method, currency, status: err.status },
            'Airwallex schema fetch failed — unsupported combination'
          );
          return reply.status(400).send({
            error: 'This country/currency/method combination is not supported for payouts.',
          });
        }

        const airwallexErr =
          err instanceof AirwallexApiError || err instanceof AirwallexAuthError ? err : undefined;

        fastify.log.error(
          {
            countryCode: country,
            method,
            currency,
            airwallexStatus: airwallexErr?.status,
            airwallexBody: airwallexErr && truncateAirwallexDetail(airwallexErr.detail),
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          },
          'Airwallex schema fetch failed'
        );
        Sentry.captureException(err, {
          extra: {
            countryCode: country,
            method,
            currency,
            airwallexStatus: airwallexErr?.status,
            op: 'payout_form_schema',
          },
        });
        return reply.status(502).send({
          error: 'Failed to fetch payout form schema. Please try again.',
        });
      }
    }
  );
  return Promise.resolve();
}
