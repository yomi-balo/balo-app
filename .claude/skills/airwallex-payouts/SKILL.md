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

## Happy Path: Full Payout Flow

End-to-end from admin clicking "Pay expert" to webhook confirming delivery:

```
1. Expert fills payout details (BAL-196)
   └─ GET /api/payouts/schema?country=AU   → proxy to Airwallex form schema
   └─ POST /api/payouts/details            → save form values to DB

2. Admin triggers beneficiary registration (BAL-203)
   └─ Check: expert.airwallex_beneficiary_id set? → skip if yes
   └─ POST /beneficiaries/create           → get beneficiary_id
   └─ Store beneficiary_id on expert record

3. Admin initiates payout (BAL-202)
   └─ GET /balances/current                → verify AUD balance sufficient
   └─ POST /transfers/create (with x-idempotency-key)
   └─ Store transfer record in DB (status: pending)

4. Airwallex fires webhooks as transfer progresses
   └─ payout.transfer.processing → status: processing
   └─ payout.transfer.sent       → status: sent
   └─ payout.transfer.paid       → status: paid ✅ (mark expert_earnings as disbursed)
   └─ payout.transfer.failed     → status: failed ❌ (alert admin)
```

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

Environment selection is driven by `AIRWALLEX_ENV=demo|prod` (default: `demo`).

**Sandbox dashboard:** https://demo.airwallex.com/app → Settings → Developer → Webhooks → click subscription → copy Secret.

---

## AirwallexClient Service

Location: `apps/api/src/services/airwallex/client.ts`

### Token Management

```ts
// POST /authentication/login
// Headers: x-client-id, x-api-key (NOT Bearer — auth headers, not Authorization)
// Returns: { token: string, expires_at: string (ISO8601) }
//
// RULES:
// - Cache the token in memory (module-level singleton)
// - Reuse until expires_at (30 min TTL)
// - Do NOT call /authentication/login before every request
// - Refresh proactively when within 60s of expiry

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

Handles token refresh on `credentials_expired` 401 with one automatic retry. Accepts optional idempotency key for mutation requests.

```ts
async function airwallexRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { idempotencyKey?: string; isRetry?: boolean },
): Promise<T> {
  const env = process.env.AIRWALLEX_ENV ?? 'demo';
  const base = env === 'prod'
    ? process.env.AIRWALLEX_API_BASE_PROD!
    : process.env.AIRWALLEX_API_BASE_DEMO!;

  const token = await getToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  if (options?.idempotencyKey) {
    headers['x-idempotency-key'] = options.idempotencyKey;
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Token expired mid-request — clear cache and retry once
  if (res.status === 401 && !options?.isRetry) {
    const errText = await res.text();
    if (errText.includes('credentials_expired')) {
      tokenCache = null;
      return airwallexRequest(method, path, body, { ...options, isRetry: true });
    }
    throw new AirwallexApiError(401, path, errText);
  }

  if (!res.ok) {
    throw new AirwallexApiError(res.status, path, await res.text());
  }

  return res.json() as T;
}
```

---

## Beneficiary Schema API (used by BAL-196)

Balo uses the **form schema** endpoint (not the API schema) — it includes field labels, options, and UI rendering hints needed to build the dynamic form.

```ts
// POST /beneficiary_form_schemas/generate

interface BeneficiarySchemaRequest {
  bank_country_code: string;  // ISO 3166-2, e.g. "AU"
  account_currency?: string;  // ISO 4217, e.g. "AUD"
  transfer_method?: 'LOCAL' | 'SWIFT';
  entity_type?: 'PERSONAL' | 'COMPANY';
}

interface FormSchemaField {
  path: string;         // e.g. "beneficiary.bank_details.bsb_number"
  required: boolean;
  enabled: boolean;
  rule: { type: string; pattern?: string };
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

### Backend Proxy Route

```ts
// GET /api/payouts/schema?country=AU&method=LOCAL&currency=AUD

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

## Beneficiary Create & Lookup (used by BAL-203)

### Idempotency Check Before Creating

Always check if the expert already has a beneficiary before creating — never create duplicates.

```ts
async function getOrCreateBeneficiary(expert: Expert): Promise<string> {
  // Primary check: DB record
  if (expert.airwallexBeneficiaryId) return expert.airwallexBeneficiaryId;

  const payload = buildBeneficiaryPayload(expert.payoutFormValues, expert.fullName);
  const result = await airwallexRequest('POST', '/beneficiaries/create', payload, {
    idempotencyKey: `balo-beneficiary-${expert.id}`,
  });

  await db.update(experts)
    .set({ airwallexBeneficiaryId: result.id })
    .where(eq(experts.id, expert.id));

  return result.id;
}
```

### Beneficiary Listing (for admin reconciliation)

```ts
// GET /beneficiaries?page_num=0&page_size=50
// Returns: { items: Beneficiary[], has_more: boolean }

async function listBeneficiaries(pageNum = 0, pageSize = 50) {
  return airwallexRequest('GET', `/beneficiaries?page_num=${pageNum}&page_size=${pageSize}`);
}
```

### CreateBeneficiaryRequest Shape

```ts
interface CreateBeneficiaryRequest {
  nickname: string;                        // Expert's full name
  payer_entity_type: 'COMPANY';            // Always COMPANY — Balo is the payer
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
      // Other schema fields: account_number, bsb_number, swift_code, iban, etc.
    };
    address?: { country_code: string; /* other address fields */ };
  };
}
```

### Path → Object Reconstruction

**Important:** Set `transfer_methods` before the loop and skip the `transfer_method` path — lodash `set` would overwrite the array with a string.

```ts
import { set } from 'lodash';

function buildBeneficiaryPayload(
  formValues: Record<string, string>,
  expertName: string,
): CreateBeneficiaryRequest {
  const transferMethod = formValues['transfer_method'] ?? 'LOCAL';

  const payload: Record<string, unknown> = {
    nickname: expertName,
    payer_entity_type: 'COMPANY',
    transfer_methods: [transferMethod],  // array at root level
  };

  for (const [path, value] of Object.entries(formValues)) {
    if (!value) continue;
    if (path === 'transfer_method') continue; // already handled above
    set(payload, path, value);
  }

  return payload as CreateBeneficiaryRequest;
}
```

---

## Transfers (used by BAL-202 admin dashboard)

### FX / Multi-Currency

- **`transfer_amount`** — send a fixed amount to the recipient (e.g. "pay them exactly AUD 500"). Airwallex deducts whatever is needed from the source wallet.
- **`source_amount`** — debit a fixed amount from the wallet (e.g. "spend exactly AUD 500"). The recipient gets the net after FX.

For same-currency payouts (AUD → AUD expert), use `transfer_amount`. For cross-currency payouts, use `source_amount` and show the FX estimate to the admin before confirming. Only one of the two should be set per request.

### Balance Check Before Transfer

```ts
// GET /balances/current
// Returns: Array<{ currency: string, available_amount: number, ... }>
// Always verify sufficient AUD balance before initiating. Show in admin payout UI.

async function getAudBalance(): Promise<number> {
  const balances = await airwallexRequest<BalanceEntry[]>('GET', '/balances/current');
  return balances.find(b => b.currency === 'AUD')?.available_amount ?? 0;
}
```

### Create Transfer

```ts
interface CreateTransferRequest {
  beneficiary_id: string;
  source_currency: string;       // e.g. "AUD"
  transfer_currency: string;     // e.g. "AUD"
  transfer_amount?: number;      // same-currency: fixed payout amount
  source_amount?: number;        // cross-currency: fixed source debit
  transfer_method: 'LOCAL' | 'SWIFT';
  reason: string;                // e.g. "Consulting earnings payout"
  reference: string;             // e.g. "BALO-PAYOUT-{expertId}-{cycleId}"
}

// ALWAYS include idempotency key — network retries must not double-pay an expert
const transfer = await airwallexRequest('POST', '/transfers/create', payload, {
  idempotencyKey: `balo-transfer-${expertId}-${payoutCycleId}`,
});

// Store transfer.id in payout_transfers table immediately after creation
```

### Transfer Listing (for reconciliation)

```ts
// GET /transfers?page_num=0&page_size=50
// Returns: { items: Transfer[], has_more: boolean }
// Use in admin dashboard for payout history and to reconcile with DB records

async function listTransfers(pageNum = 0, pageSize = 50) {
  return airwallexRequest('GET', `/transfers?page_num=${pageNum}&page_size=${pageSize}`);
}
```

---

## Webhook Handler (used by BAL-202)

Location: `apps/api/src/routes/webhooks/airwallex.ts`

### Fastify rawBody Plugin Setup

Register at server startup — required before the webhook route is registered:

```ts
// apps/api/src/server.ts
import rawBody from 'fastify-raw-body';

await fastify.register(rawBody, {
  field: 'rawBody',    // req.rawBody will be set
  global: false,        // opt-in per route only
  encoding: false,      // keep as Buffer
  runFirst: true,       // run before body parsers
});
```

Activate on the webhook route:

```ts
fastify.post('/webhooks/airwallex', {
  config: { rawBody: true },
}, handler);
```

### Signature Verification

**CRITICAL:** Verify using the **raw body buffer** before any JSON parsing. Re-serialising parsed JSON changes byte order and breaks the signature.

```ts
import { createHmac, timingSafeEqual } from 'crypto';

function verifyAirwallexWebhook(
  rawBody: Buffer,
  timestamp: string,    // x-timestamp header (Unix ms as string)
  signature: string,    // x-signature header
  secret: string,
): boolean {
  // Exact order: timestamp string + raw body string
  const valueToDigest = timestamp + rawBody.toString('utf8');

  const expected = createHmac('sha256', secret)
    .update(valueToDigest)
    .digest('hex');

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

### Route Implementation with Replay Protection

```ts
fastify.post('/webhooks/airwallex', {
  config: { rawBody: true },
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

  const event = req.body as AirwallexWebhookEvent;
  const webhookId = event.id;

  // Replay protection: Airwallex retries on non-2xx — deduplicate by event ID
  const already = await db.query.processedWebhooks.findFirst({
    where: eq(processedWebhooks.webhookId, webhookId),
  });
  if (already) return reply.status(200).send({ received: true });

  await db.insert(processedWebhooks).values({ webhookId, processedAt: new Date() });

  // ACK immediately before processing
  reply.status(200).send({ received: true });

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

> ⚠️ Do NOT use `payment.*` event names — those are from older API versions.

### BullMQ Worker

```ts
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
  if (!status) return;

  const transferId = event.data?.transfer_id ?? event.data?.id;

  await db.update(payoutTransfers)
    .set({ status, updatedAt: new Date() })
    .where(eq(payoutTransfers.airwallexTransferId, transferId));

  if (status === 'paid') {
    await db.update(expertEarnings)
      .set({ disbursedAt: new Date() })
      .where(eq(expertEarnings.payoutTransferId, /* internal record id */));
  }

  if (status === 'failed') {
    await notificationService.alertAdmin('payout_failed', { transferId });
  }
});
```

---

## Database Schema

Use the drizzle-schema skill for conventions. Key Drizzle column definitions:

```ts
// experts table — add these columns:
airwallexBeneficiaryId: varchar('airwallex_beneficiary_id', { length: 255 }),
payoutCountryCode: char('payout_country_code', { length: 2 }),

// payout_transfers table:
export const payoutTransfers = pgTable('payout_transfers', {
  id: uuid('id').primaryKey().defaultRandom(),
  expertId: uuid('expert_id').notNull().references(() => experts.id),
  airwallexTransferId: varchar('airwallex_transfer_id', { length: 255 }).unique(),
  amountAud: numeric('amount_aud', { precision: 10, scale: 2 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  // status values: pending | processing | sent | paid | failed | cancelled
  initiatedBy: uuid('initiated_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// processed_webhooks table (replay protection):
export const processedWebhooks = pgTable('processed_webhooks', {
  webhookId: varchar('webhook_id', { length: 255 }).primaryKey(),
  processedAt: timestamp('processed_at').notNull().defaultNow(),
});
// Add index on processedAt for periodic cleanup of old entries
```

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
  constructor(
    public readonly status: number,
    public readonly path: string,
    detail: string,
  ) {
    super(`Airwallex API error ${status} at ${path}: ${detail}`);
    this.name = 'AirwallexApiError';
  }
}
```

Common errors:
- `SCHEMA_DEFINITION_NOT_FOUND` (400) — invalid country/currency/method combination. Return user-friendly message.
- `credentials_invalid` (401) — bad API key. Check env vars.
- `credentials_expired` (401) — handled automatically by `airwallexRequest` retry logic.

---

## Security Rules

1. **Never expose Airwallex credentials to Next.js/Vercel.** All env vars are Railway-only (Fastify API service).
2. **Never log raw Airwallex API keys or tokens.**
3. **Always verify webhook signatures** before processing. Return 401 on failure.
4. **Use `timingSafeEqual`** for signature comparison (prevents timing attacks).
5. **Always use idempotency keys** on `POST /transfers/create` and `POST /beneficiaries/create`.
6. **Store processed webhook IDs** to prevent duplicate processing on Airwallex retries.
7. **IP allowlisting** applied at go-live (BAL-206/BAL-207) — demo key is unrestricted.

---

## Testing in Sandbox

The Airwallex MCP (`https://mcp-demo.airwallex.com/developer`) is in `.mcp.json` and available in Claude Code. Use it to:
- `list_beneficiaries` — verify beneficiary creation succeeded
- `get_balances` — check AUD balance before initiating transfers
- `simulate_transfer_result` — progress transfer through `SENT` → `PAID`

Sandbox AUD balance: $10,000,000. Use freely.

Do NOT test against `https://api.airwallex.com` (production) during development.
