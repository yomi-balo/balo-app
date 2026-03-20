# Cronofy Error Handling & Token Recovery

---

## Error Response Shape

Cronofy API errors follow this shape:

```json
{
  "error": "invalid_grant",
  "error_description": "The authorization code is invalid or expired"
}
```

The SDK throws these as Error objects with a `.status` property for HTTP status code.

---

## Common Errors & Handling

| Status | Error                      | Cause                                    | Action                                         |
| ------ | -------------------------- | ---------------------------------------- | ---------------------------------------------- |
| 401    | `invalid_token`            | Access token expired                     | Refresh token, retry                           |
| 401    | `invalid_grant`            | Refresh token revoked (user removed app) | Mark connection as `auth_error`, notify expert |
| 403    | `insufficient_permissions` | Missing scope                            | Re-prompt OAuth with full scope                |
| 404    | Not found                  | Event/rule doesn't exist                 | Safe to ignore on delete                       |
| 422    | Validation error           | Invalid params                           | Log and throw — programmer error               |
| 429    | Rate limited               | Too many requests                        | Exponential backoff                            |
| 5xx    | Server error               | Cronofy transient                        | Exponential backoff                            |

---

## Token Expiry Recovery

```typescript
// Wrap any Cronofy API call in this helper
export async function withCronofyRetry<T>(
  expertId: string,
  operation: (accessToken: string) => Promise<T>
): Promise<T> {
  const accessToken = await getValidAccessToken(expertId);

  try {
    return await operation(accessToken);
  } catch (err) {
    const status = (err as any).status;
    const errorCode = (err as any).error;

    if (status === 401 && errorCode !== 'invalid_grant') {
      // Token may have just expired — try refreshing once
      const freshToken = await forceRefreshToken(expertId);
      return await operation(freshToken);
    }

    if (status === 401 && errorCode === 'invalid_grant') {
      // Refresh token revoked — user removed Balo from their Google/Outlook account
      await handleTokenRevoked(expertId);
      throw new CalendarAuthError(`Calendar authorization revoked for expert ${expertId}`);
    }

    throw err;
  }
}
```

---

## Handle Token Revoked

```typescript
async function handleTokenRevoked(expertId: string): Promise<void> {
  // Mark connection as auth_error
  await db
    .update(calendarConnections)
    .set({ status: 'auth_error', updatedAt: new Date() })
    .where(eq(calendarConnections.expertId, expertId));

  // Clear availability cache — expert is effectively unavailable
  await db
    .update(availabilityCache)
    .set({ earliestAvailableAt: null, updatedAt: new Date() })
    .where(eq(availabilityCache.expertId, expertId));

  // Invalidate Redis cache
  await invalidateAvailabilityCache(expertId);

  // Notify expert via email (Brevo)
  await sendCalendarReconnectNotification(expertId);

  // Log to Sentry
  Sentry.captureMessage(`Calendar token revoked for expert ${expertId}`, {
    level: 'warning',
    extra: { expertId },
  });
}
```

---

## Rate Limiting

Cronofy rate limits are generous but apply per application. With ~50 experts, well within limits.

```typescript
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; backoff: number[]; retryIf: (err: unknown) => boolean }
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < opts.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!opts.retryIf(err)) throw err;
      if (i < opts.attempts - 1) {
        await sleep(opts.backoff[i] ?? opts.backoff[opts.backoff.length - 1]);
      }
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

---

## Custom Error Classes

```typescript
export class CalendarAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarAuthError';
  }
}

export class CalendarWriteError extends Error {
  constructor(
    message: string,
    public readonly consultationId: string
  ) {
    super(message);
    this.name = 'CalendarWriteError';
  }
}

export class CalendarNotConnectedError extends Error {
  constructor(expertId: string) {
    super(`Expert ${expertId} has no connected calendar`);
    this.name = 'CalendarNotConnectedError';
  }
}
```

---

## Monitoring

All Cronofy errors should be logged with expert context:

```typescript
Sentry.withScope((scope) => {
  scope.setTag('integration', 'cronofy');
  scope.setUser({ id: expertId });
  scope.setExtra('operation', 'upsertEvent');
  Sentry.captureException(err);
});
```

Alert thresholds (configure in Sentry):

- `auth_error` connections: alert immediately
- Calendar write failures: alert after 2 within 1 hour
- Stale connections (> 30 min without sync): alert if 3+ experts affected
