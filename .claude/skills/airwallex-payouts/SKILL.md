# Airwallex Payouts Skill

This skill governs all Airwallex API work in Balo. Read it in full before writing any Airwallex-related code.

---

## Architecture Overview

Balo uses Airwallex **exclusively for expert payout disbursements**. There is no Stripe Connect. The flow is:

1. Client pays Balo via Stripe (single Stripe account — Balo's)
2. Expert earnings tracked in DB ledger (`expert_earnings` table)
3. Admin initiates payouts to experts via Airwallex transfers
4. Expert provides their bank details via BAL-196 UI → stored as Airwallex beneficiary

**Airwallex is a backend-only integration.** Credentials never touch the frontend or Vercel. All calls go through the Fastify API.

---

## Environment Configuration

```
AIRWALLEX_CLIENT_ID_DEMO=
AIRWALLEX_API_KEY_DEMO=
AIRWALLEX_CLIENT_ID_PROD=
AIRWALLEX_API_KEY_PROD=
AIRWALLEX_API_BASE_DEMO=https://api-demo.airwallex.com/api/v1
AIRWALLEX_API_BASE_PROD=https://api.airwallex.com/api/v1
AIRWALLEX_WEBHOOK_SECRET_DEMO=
AIRWALLEX_WEBHOOK_SECRET_PROD=
```

Environment selection is driven by `AIRWALLEX_ENV=demo|prod` (default: `demo`). The `AirwallexClient` reads this at startup.

---

## AirwallexClient Service

Location: `apps/api/src/services/airwallex/client.ts`

### Token Management

```ts
// POST /authentication/login
// Headers: x-client-id, x-api-key
// Returns: { token: string, expires_at: string }

// RULES:
// - Cache the token in memory (module-level singleton)
// - Reuse until expires_at (30 min TTL)
// - Do NOT call /authentication/login before every request
// - Refresh proactively when within 60s of expiry
```

```ts
interface TokenCache {
  token: string;
  expiresAt: Date;
}

let tokenCache: TokenCache | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > new Date(Date.now() + 60_000)) {
    return tokenCache.token;
  }

  const env = process.env.AIRWALLEX_ENV ?? 'demo';
  const base = env === 'prod'
    ? process.env.AIRWALLEX_API_BASE_PROD!
    : process.env.AIRWALLEX_API_BASE_DEMO!;

  const res = await fetch(`${base}/authentication/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': env === 'prod'
        ? process.env.AIRWALLEX_CLIENT_ID_PROD!
        : process.env.AIRWALLEX_CLIENT_ID_DEMO!,
      'x-api-key': env === 'prod'
        ? process.env.AIRWALLEX_API_KEY_PROD!
        : process.env.AIRWALLEX_API_KEY_DEMO!,
    },
  });

  if (!res.ok) throw new AirwallexAuthError(await res.text());

  const { token, expires_at } = await res.json();
  tokenCache = { token, expiresAt: new Date(expires_at) };
  return token;
}
```

### Request Helper

```ts
async function airwallexRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const env = process.env.AIRWALLEX_ENV ?? 'demo';
  const base = env === 'prod'
    ? process.env.AIRWALLEX_API_BASE_PROD!
    : process.env.AIRWALLEX_API_BASE_DEMO!;

  const token = await getToken();

  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new AirwallexApiError(res.status, path, text);
  }

  return res.json() as T;
}
```

---

## Beneficiary Schema API (used by BAL-196)

Balo uses the **form schema** endpoint (not the API schema) because it includes field labels, options, and UI rendering hints needed to build the dynamic form.

```ts
// POST /beneficiary_form_schemas/generate
// Auth: Bearer token

interface BeneficiarySchemaRequest {
  bank_country_code: string;  // ISO 3166-2, e.g. "AU"
  account_currency?: string;  // ISO 4217, e.g. "AUD"
  transfer_method?: 'LOCAL' | 'SWIFT';
  entity_type?: 'PERSONAL' | 'COMPANY';
}

// Response fields[] shape (simplified):
interface FormSchemaField {
  path: string;         // e.g. "beneficiary.bank_details.bsb_number"
  required: boolean;
  enabled: boolean;
  rule: {
    type: string;       // "string", "number"
    pattern?: string;   // regex validation
  };
  field: {
    key: string;
    label: string;
    description?: string;
    placeholder?: string;
    tip?: string;
    type: string;       // "TEXT", "SELECT", "RADIO", "TRANSFER_METHOD"
    options?: Array<{ label: string; value: string }>;
    default?: string;
    refresh?: boolean;  // if true, changing this field should re-fetch schema
  };
}
```

### Balo's Backend Proxy Route

```ts
// GET /api/payouts/schema?country=AU&method=LOCAL&currency=AUD
// Fastify route — proxies to Airwallex, normalises response

fastify.get('/api/payouts/schema', async (req, reply) => {
  const { country, method = 'LOCAL', currency } = req.query as {
    country: string;
    method?: string;
    currency?: string;
  };

  const schema = await airwallexRequest('POST', '/beneficiary_form_schemas/generate', {
    bank_country_code: country,
    transfer_method: method,
    account_currency: currency,
    entity_type: 'PERSONAL',
  });

  // Only return enabled fields to the frontend
  const fields = schema.fields
    .filter((f: FormSchemaField) => f.enabled)
    .map((f: FormSchemaField) => ({
      path: f.path,
      required: f.required,
      label: f.field.label,
      description: f.field.description,
      placeholder: f.field.placeholder,
      tip: f.field.tip,
      type: f.field.type === 'SELECT' || f.field.type === 'RADIO' ? 'enum' : 'text',
      options: f.field.options,
      defaultValue: f.field.default,
      refresh: f.field.refresh ?? false,
      validation: f.rule.pattern ? { pattern: f.rule.pattern } : undefined,
    }));

  return reply.send({ fields, condition: schema.condition });
});
```

**Frontend note:** `refresh: true` fields (e.g. `entity_type`, `transfer_method`, `bank_country_code`) should trigger a schema re-fetch when changed.

---

## Beneficiary Create (used by BAL-203)

```ts
// POST /beneficiaries/create
// Builds the nested beneficiary object from the form fields collected in BAL-196.
// Fields are stored by their `path` — reconstruct the nested object using path notation.

interface CreateBeneficiaryRequest {
  nickname: string;                // Expert's full name
  payer_entity_type: 'COMPANY';   // Always COMPANY — Balo is the payer
  transfer_methods: Array<'LOCAL' | 'SWIFT'>;
  beneficiary: {
    entity_type: 'PERSONAL' | 'COMPANY';
    first_name?: string;
    last_name?: string;
    company_name?: string;
    bank_details: {
      bank_country_code: string;
      account_currency: string;
      account_name: string;
      // ... other fields from schema (account_number, bsb_number, swift_code, iban, etc.)
    };
    address?: {
      country_code: string;
      // ... other address fields if schema requires them
    };
  };
}

// Response includes beneficiary `id` — store this as expert.airwallex_beneficiary_id
```

### Path → Object Reconstruction

Schema fields come with dotted paths like `beneficiary.bank_details.bsb_number`. Use a path-setter utility to rebuild the nested object:

```ts
import { set } from 'lodash'; // or implement manually

function buildBeneficiaryPayload(
  formValues: Record<string, string>,
  expertName: string,
): CreateBeneficiaryRequest {
  const payload: Record<string, unknown> = {
    nickname: expertName,
    payer_entity_type: 'COMPANY',
    transfer_methods: [formValues['transfer_method'] ?? 'LOCAL'],
  };

  for (const [path, value] of Object.entries(formValues)) {
    if (value) set(payload, path, value);
  }

  return payload as CreateBeneficiaryRequest;
}
```

---

## Transfers (used by BAL-202 admin dashboard)

```ts
// POST /transfers/create
// Requires beneficiary_id stored in expert profile

interface CreateTransferRequest {
  beneficiary_id: string;
  source_currency: string;      // e.g. "AUD"
  transfer_currency: string;    // e.g. "AUD"
  transfer_amount?: number;     // specify one of transfer_amount OR source_amount
  source_amount?: number;
  transfer_method: 'LOCAL' | 'SWIFT';
  reason: string;               // e.g. "Consulting earnings payout"
  reference: string;            // e.g. "BALO-PAYOUT-{expertId}-{cycleId}"
}

// Response includes transfer `id` — store for reconciliation and webhook matching
```

---

## Webhook Handler (used by BAL-202)

Location: `apps/api/src/routes/webhooks/airwallex.ts`

### Signature Verification

**CRITICAL:** Verify signature using the **raw body buffer** BEFORE any JSON parsing. Fastify's `addContentTypeParser` or `rawBody` plugin is needed.

```ts
import { createHmac, timingSafeEqual } from 'crypto';

function verifyAirwallexWebhook(
  rawBody: Buffer,
  timestamp: string,    // from x-timestamp header (Unix ms as string)
  signature: string,    // from x-signature header
  secret: string,
): boolean {
  // Concatenate: timestamp string + raw body string (exact order matters)
  const valueToDigest = timestamp + rawBody.toString('utf8');

  const expected = createHmac('sha256', secret)
    .update(valueToDigest)
    .digest('hex');

  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex'),
    );
  } catch {
    return false;
  }
}
```

### Route Implementation

```ts
fastify.post('/webhooks/airwallex', {
  config: { rawBody: true }, // ensure raw body is available
}, async (req, reply) => {
  const timestamp = req.headers['x-timestamp'] as string;
  const signature = req.headers['x-signature'] as string;

  const env = process.env.AIRWALLEX_ENV ?? 'demo';
  const secret = env === 'prod'
    ? process.env.AIRWALLEX_WEBHOOK_SECRET_PROD!
    : process.env.AIRWALLEX_WEBHOOK_SECRET_DEMO!;

  if (!verifyAirwallexWebhook(req.rawBody!, timestamp, signature, secret)) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }

  // ACK immediately — process async via BullMQ job
  reply.status(200).send({ received: true });

  const event = req.body as AirwallexWebhookEvent;
  await payoutQueue.add('process-airwallex-webhook', { event });
});
```

### Webhook Events (current API)

| Event | Meaning |
|---|---|
| `payout.transfer.processing` | Transfer funded and in progress |
| `payout.transfer.sent` | Sent from Airwallex to banking partner |
| `payout.transfer.paid` | Confirmed delivered ✅ |
| `payout.transfer.failed` | Failed — notify admin ❌ |
| `payout.transfer.cancelled` | Cancelled, funds returned |

> ⚠️ Do NOT use `payment.*` event names — those are from older API versions and do not exist in the current API.

### Event Processing (BullMQ Worker)

```ts
// Map event name → transfer status update in DB
const EVENT_TO_STATUS: Record<string, string> = {
  'payout.transfer.processing': 'processing',
  'payout.transfer.sent': 'sent',
  'payout.transfer.paid': 'paid',
  'payout.transfer.failed': 'failed',
  'payout.transfer.cancelled': 'cancelled',
};

worker.process('process-airwallex-webhook', async (job) => {
  const { event } = job.data;
  const status = EVENT_TO_STATUS[event.name];
  if (!status) return; // ignore unknown events

  const transferId = event.data?.transfer_id ?? event.data?.id;
  await db.update(payoutTransfers)
    .set({ status, updatedAt: new Date() })
    .where(eq(payoutTransfers.airwallexTransferId, transferId));

  if (status === 'failed') {
    // Alert admin via notification service
    await notificationService.alertAdmin('payout_failed', { transferId });
  }
});
```

---

## Database Schema Notes

The `experts` table should have:
- `airwallex_beneficiary_id: varchar` — populated after BAL-203 beneficiary registration
- `payout_country_code: varchar(2)` — the country selected in BAL-196 form

The `payout_transfers` table should have:
- `airwallex_transfer_id: varchar` — Airwallex's transfer ID
- `expert_id: uuid`
- `amount_aud: decimal` — source amount
- `status: enum('pending','processing','sent','paid','failed','cancelled')`
- `initiated_by: uuid` — admin user ID
- `created_at`, `updated_at`

---

## Error Handling

```ts
class AirwallexAuthError extends Error {
  constructor(detail: string) {
    super(`Airwallex auth failed: ${detail}`);
    this.name = 'AirwallexAuthError';
  }
}

class AirwallexApiError extends Error {
  constructor(status: number, path: string, detail: string) {
    super(`Airwallex API error ${status} at ${path}: ${detail}`);
    this.name = 'AirwallexApiError';
  }
}
```

Common errors:
- `SCHEMA_DEFINITION_NOT_FOUND` (400) — invalid country/currency/method combination. Return user-friendly message.
- `credentials_invalid` (401) — bad API key. Check env vars.
- `credentials_expired` (401) — token expired mid-request. Clear cache, retry once.

---

## Security Rules

1. **Never expose Airwallex credentials to Next.js/Vercel.** All env vars are Railway-only (Fastify API service).
2. **Never log raw Airwallex API keys or tokens.**
3. **Always verify webhook signatures** before processing. Return 401 on failure.
4. **Use `timingSafeEqual`** for signature comparison (prevents timing attacks).
5. **IP allowlisting** will be applied at go-live (BAL-206/BAL-207) — demo key is unrestricted.

---

## Testing in Sandbox

The Airwallex MCP (`https://mcp-demo.airwallex.com/developer`) is configured in `.mcp.json` and available in Claude Code. Use it to:
- Verify beneficiary creation succeeded
- Simulate transfer status progression: `SENT` → `PAID`
- Check balances before/after test transfers

Sandbox has pre-funded AUD $10,000,000 balance. Use it freely.

Do NOT register or test against `https://api.airwallex.com` (production) during development.
