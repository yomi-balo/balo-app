# External Service Mocking Patterns — Balo Platform

## Principles

1. **Mock at the boundary** — mock the SDK/client, not individual HTTP calls
2. **Keep mocks minimal** — only mock what the test needs, use `vi.fn()` for the rest
3. **Centralise mocks** — one file per service in `src/test/mocks/`, import as needed
4. **Return realistic shapes** — match the actual SDK response types

## Service Mock Catalogue

### WorkOS (Authentication)

```typescript
// src/test/mocks/workos.ts
import { vi } from 'vitest';

export function createMockWorkOS(overrides = {}) {
  return {
    userManagement: {
      authenticateWithCode: vi.fn().mockResolvedValue({
        user: {
          id: 'user_01TEST',
          email: 'test@example.com',
          firstName: 'Test',
          lastName: 'User',
          profilePictureUrl: null,
          emailVerified: true,
        },
        accessToken: 'at_test_xxx',
        refreshToken: 'rt_test_xxx',
      }),
      authenticateWithPassword: vi.fn().mockResolvedValue({
        user: { id: 'user_01TEST', email: 'test@example.com' },
        accessToken: 'at_test_xxx',
      }),
      createUser: vi.fn().mockResolvedValue({
        id: 'user_01NEW',
        email: 'new@example.com',
      }),
      getUser: vi.fn().mockResolvedValue({
        id: 'user_01TEST',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
      }),
      sendPasswordResetEmail: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    },
  };
}

// Usage in test file:
// vi.mock('@workos-inc/node', () => ({
//   WorkOS: vi.fn(() => createMockWorkOS()),
// }));
```

### Stripe Connect (Payments)

```typescript
// src/test/mocks/stripe.ts
import { vi } from 'vitest';

export function createMockStripe(overrides = {}) {
  return {
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: 'cs_test_123',
          url: 'https://checkout.stripe.com/c/pay/test',
          payment_status: 'unpaid',
        }),
        retrieve: vi.fn().mockResolvedValue({
          id: 'cs_test_123',
          payment_status: 'paid',
          metadata: { caseId: 'case_test_1' },
        }),
      },
    },
    accounts: {
      create: vi.fn().mockResolvedValue({
        id: 'acct_test_expert',
        details_submitted: false,
      }),
      retrieve: vi.fn().mockResolvedValue({
        id: 'acct_test_expert',
        charges_enabled: true,
        payouts_enabled: true,
      }),
    },
    accountLinks: {
      create: vi.fn().mockResolvedValue({
        url: 'https://connect.stripe.com/setup/test',
      }),
    },
    transfers: {
      create: vi.fn().mockResolvedValue({
        id: 'tr_test_123',
        amount: 8000,
        destination: 'acct_test_expert',
      }),
    },
    webhooks: {
      constructEvent: vi.fn().mockImplementation((body, _sig, _secret) => {
        return JSON.parse(typeof body === 'string' ? body : body.toString());
      }),
    },
    ...overrides,
  };
}
```

### Supabase Realtime (Chat/Presence)

```typescript
// src/test/mocks/supabase.ts
import { vi } from 'vitest';

export function createMockSupabaseChannel() {
  const channel = {
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnValue({ status: 'SUBSCRIBED' }),
    unsubscribe: vi.fn(),
    send: vi.fn().mockResolvedValue('ok'),
    track: vi.fn(), // presence
    untrack: vi.fn(),
  };
  return channel;
}

export function createMockSupabaseClient() {
  const channel = createMockSupabaseChannel();
  return {
    channel: vi.fn().mockReturnValue(channel),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
      then: vi.fn(),
    }),
    _channel: channel, // exposed for test assertions
  };
}
```

### Recall.ai (Meeting Capture)

```typescript
// src/test/mocks/recall.ts
import { vi } from 'vitest';

export function createMockRecallClient() {
  return {
    createBot: vi.fn().mockResolvedValue({
      id: 'bot_test_123',
      status: 'ready',
      meeting_url: 'https://daily.co/test-room',
    }),
    getBot: vi.fn().mockResolvedValue({
      id: 'bot_test_123',
      status: 'in_call',
    }),
    getBotTranscript: vi.fn().mockResolvedValue({
      transcript: [
        { speaker: 'Expert', text: 'Hello, how can I help?', timestamp: 0 },
        { speaker: 'Client', text: 'I need help with Salesforce.', timestamp: 5 },
      ],
    }),
  };
}
```

### Daily.co (Video Meetings)

```typescript
// src/test/mocks/daily.ts
import { vi } from 'vitest';

export function createMockDailyClient() {
  return {
    createRoom: vi.fn().mockResolvedValue({
      name: 'test-room-abc',
      url: 'https://balo.daily.co/test-room-abc',
      config: { enable_recording: false },
    }),
    createMeetingToken: vi.fn().mockResolvedValue({
      token: 'eyJ_test_daily_token',
    }),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
  };
}
```

### Brevo (Email)

```typescript
// src/test/mocks/brevo.ts
import { vi } from 'vitest';

export function createMockBrevoClient() {
  return {
    sendTransacEmail: vi.fn().mockResolvedValue({ messageId: 'msg_test_123' }),
    sendTransacSms: vi.fn().mockResolvedValue({ messageId: 'sms_test_123' }),
  };
}
```

## Pattern: Testing Webhook Handlers

Webhook tests need to verify:

1. Signature validation (reject invalid signatures)
2. Event routing (correct handler for event type)
3. Side effects (DB updates, notifications, state transitions)
4. Idempotency (same event processed twice doesn't duplicate)

```typescript
describe('Stripe webhook handler', () => {
  it('rejects invalid signature', async () => {
    /* 400 */
  });
  it('ignores unhandled event types', async () => {
    /* 200, no side effects */
  });
  it('processes checkout.session.completed', async () => {
    /* updates case, notifies */
  });
  it('is idempotent on duplicate delivery', async () => {
    /* no duplicate records */
  });
});
```

## Pattern: Testing Server Actions

Server Actions combine auth + validation + DB + external services. Mock external boundaries, use real DB when possible:

```typescript
describe('createCaseBooking', () => {
  // Mock: Stripe (external payment), WorkOS (auth context)
  // Real: Database (test DB), Zod validation

  it('rejects unauthenticated users', async () => {
    // Mock session as null
    await expect(createCaseBooking(validInput)).rejects.toThrow(/unauthorized/i);
  });

  it('validates input schema', async () => {
    // Mock session as valid, provide bad input
    await expect(createCaseBooking({ expertId: '' })).rejects.toThrow();
  });

  it('creates booking and Stripe session', async () => {
    // Mock session + Stripe, real DB
    const result = await createCaseBooking(validInput);
    expect(result.checkoutUrl).toContain('checkout.stripe.com');
    // Assert DB record created
  });
});
```
