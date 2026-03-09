import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { airwallexRequest } from '../../services/airwallex/client.js';
import { AirwallexApiError } from '../../services/airwallex/errors.js';

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

// ── Route ───────────────────────────────────────────────────────

export async function schemaRoute(fastify: FastifyInstance): Promise<void> {
  // TODO: Add preHandler: [fastify.requireAuth] once the auth plugin is built (BAL-191)
  // This endpoint returns only public Airwallex form metadata, no user data.
  // CORS is locked to CORS_ORIGIN, limiting cross-origin access.
  fastify.get('/api/payouts/schema', async (request, reply) => {
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

      const fields: NormalizedField[] = schema.fields
        .filter((f: FormSchemaField) => f.enabled)
        .map((f: FormSchemaField) => ({
          path: f.path,
          required: f.required,
          label: f.field.label,
          description: f.field.description,
          placeholder: f.field.placeholder,
          tip: f.field.tip,
          type:
            f.field.type === 'SELECT' || f.field.type === 'RADIO'
              ? ('enum' as const)
              : ('text' as const),
          options: f.field.options,
          defaultValue: f.field.default,
          refresh: f.field.refresh ?? false,
          validation: f.rule?.pattern ? { pattern: f.rule.pattern } : undefined,
          wide: WIDE_FIELD_KEYS.has(f.path),
        }));

      return reply.send({ fields, condition: schema.condition });
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

      fastify.log.error(
        {
          countryCode: country,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        'Airwallex schema fetch failed'
      );
      return reply.status(502).send({
        error: 'Failed to fetch payout form schema. Please try again.',
      });
    }
  });
}
