# Webhooks & Sessions — Balo

## WorkOS Webhook Events

WorkOS sends webhook events when user data changes. These keep your Supabase `users` table in sync with WorkOS.

### Webhook Endpoint

```typescript
// apps/api/src/routes/webhooks/getWorkOS().ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getWorkOS } from '@/lib/auth/config';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function workosWebhookRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/webhooks/workos',
    {
      config: {
        rawBody: true, // Need raw body for signature verification
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const signature = req.headers['workos-signature'] as string;
      const rawBody = (req as any).rawBody as string;

      if (!signature || !rawBody) {
        return reply.status(400).send({ error: 'Missing signature or body' });
      }

      // CRITICAL: Verify webhook signature. Never skip this.
      let event;
      try {
        event = await getWorkOS().webhooks.constructEvent({
          payload: rawBody,
          sigHeader: signature,
          secret: process.env.WORKOS_WEBHOOK_SECRET!,
        });
      } catch (error) {
        fastify.log.error('Webhook signature verification failed:', error);
        return reply.status(401).send({ error: 'Invalid signature' });
      }

      // Handle events
      switch (event.event) {
        case 'user.updated':
          await handleUserUpdated(event.data);
          break;

        case 'user.deleted':
          await handleUserDeleted(event.data);
          break;

        case 'authentication.email_verification_succeeded':
          await handleEmailVerified(event.data);
          break;

        case 'session.created':
          // Log for audit purposes
          fastify.log.info(`Session created for user ${event.data.user_id}`);
          break;

        default:
          fastify.log.info(`Unhandled webhook event: ${event.event}`);
      }

      return reply.status(200).send({ received: true });
    }
  );
}

async function handleUserUpdated(data: any) {
  const workosUserId = data.id;

  await db
    .update(users)
    .set({
      email: data.email,
      firstName: data.first_name,
      lastName: data.last_name,
      updatedAt: new Date(),
    })
    .where(eq(users.workosUserId, workosUserId));
}

async function handleUserDeleted(data: any) {
  // Soft delete — don't remove the row
  await db.update(users).set({ deletedAt: new Date() }).where(eq(users.workosUserId, data.id));
}

async function handleEmailVerified(data: any) {
  await db
    .update(users)
    .set({
      emailVerified: true,
      updatedAt: new Date(),
    })
    .where(eq(users.workosUserId, data.user_id));
}
```

### Webhook Security Rules

1. **Always verify signatures** — use `getWorkOS().webhooks.constructEvent()`, never skip
2. **Use raw body** — signature is computed over raw request body, not parsed JSON
3. **Idempotency** — webhooks may be delivered more than once; use `event.id` to deduplicate
4. **Respond 200 quickly** — process heavy work async (queue to BullMQ if needed)
5. **Admin client** — webhook handlers use the admin DB client (no RLS, no user context)

### Required Fastify Config for Raw Body

```typescript
// apps/api/src/server.ts
const fastify = Fastify({
  logger: true,
});

// Enable raw body for webhook signature verification
fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try {
    const json = JSON.parse(body as string);
    (req as any).rawBody = body;
    done(null, json);
  } catch (err) {
    done(err as Error, undefined);
  }
});
```

## Key WorkOS Webhook Events

| Event                                         | When                          | Balo Action                              |
| --------------------------------------------- | ----------------------------- | ---------------------------------------- |
| `user.created`                                | User created in WorkOS        | Usually handled in callback, not webhook |
| `user.updated`                                | Profile changed (name, email) | Sync to `users` table                    |
| `user.deleted`                                | User removed from WorkOS      | Soft delete in `users` table             |
| `authentication.email_verification_succeeded` | Email verified                | Update `emailVerified` flag              |
| `session.created`                             | New login session             | Audit log                                |
| `organization_membership.created`             | User added to org             | Future: multi-org support                |
| `organization_membership.deleted`             | User removed from org         | Future: multi-org support                |

## Sign Out

```typescript
// apps/web/app/(auth)/actions/sign-out.ts
'use server';
import 'server-only';

import { clearSession } from '@/lib/auth/session';
import { redirect } from 'next/navigation';

export async function signOut() {
  await clearSession();
  redirect('/');
}
```

For proper WorkOS session invalidation (revoke refresh token):

```typescript
export async function signOutFull() {
  const session = await getSession();

  if (session?.accessToken) {
    try {
      // Revoke the session in WorkOS
      await getWorkOS().userManagement.revokeSession({
        sessionId: session.sessionId,
      });
    } catch {
      // Best effort — still clear local session
    }
  }

  await clearSession();
  redirect('/');
}
```

## Admin Impersonation

Admins can impersonate users for debugging. The original admin session is preserved.

```typescript
// apps/web/lib/auth/impersonation.ts
import 'server-only';
import { cookies } from 'next/headers';
import { getSession, setAuthSession, type BaloSession } from './session';

const IMPERSONATION_COOKIE = 'balo_admin_session';

export async function startImpersonation(targetUserId: string): Promise<void> {
  const adminSession = await getSession();
  if (!adminSession || !['admin', 'super_admin'].includes(adminSession.user.platformRole!)) {
    throw new Error('Only admins can impersonate');
  }

  // Store admin session for later restoration
  const cookieStore = await cookies();
  cookieStore.set(IMPERSONATION_COOKIE, JSON.stringify(adminSession), {
    httpOnly: true,
    secure: true,
    maxAge: 60 * 60, // 1 hour max
    path: '/',
  });

  // Load target user and set as active session
  const targetUser = await db.query.users.findFirst({
    where: eq(users.id, targetUserId),
  });

  if (!targetUser) throw new Error('Target user not found');

  const membership = await db.query.companyMembers.findFirst({
    where: eq(companyMembers.userId, targetUser.id),
    with: { company: true },
  });

  // Set impersonated session (keeps admin's tokens for API access)
  await setAuthSession({
    user: {
      id: targetUser.id,
      email: targetUser.email,
      firstName: targetUser.firstName,
      lastName: targetUser.lastName,
      activeMode: targetUser.activeMode ?? 'client',
      companyId: membership!.company.id,
      companyName: membership!.company.name,
      companyRole: membership!.role,
    },
    accessToken: adminSession.accessToken,
    refreshToken: adminSession.refreshToken,
    isImpersonating: true,
  });
}

export async function stopImpersonation(): Promise<void> {
  const cookieStore = await cookies();
  const savedSession = cookieStore.get(IMPERSONATION_COOKIE)?.value;

  if (!savedSession) {
    throw new Error('No impersonation session found');
  }

  const adminSession = JSON.parse(savedSession) as BaloSession;
  await setAuthSession(adminSession);

  cookieStore.delete(IMPERSONATION_COOKIE);
}

export async function isImpersonating(): Promise<boolean> {
  const cookieStore = await cookies();
  return cookieStore.has(IMPERSONATION_COOKIE);
}
```

### Impersonation Guards

During impersonation, certain actions should be blocked:

```typescript
export function withAuth<TArgs extends any[], TReturn>(
  action: AuthenticatedAction<TArgs, TReturn>,
  options?: { allowImpersonation?: boolean }
) {
  return async (...args: TArgs): Promise<TReturn> => {
    const session = await getSession();
    if (!session?.user?.id) {
      throw new Error('Unauthorized');
    }

    // Block destructive actions during impersonation
    if (!options?.allowImpersonation && session.isImpersonating) {
      throw new Error('This action is not available during impersonation');
    }

    return action(session, ...args);
  };
}
```

**Blocked during impersonation:**

- Changing passwords
- Deleting accounts
- Making purchases / spending credits
- Modifying payment methods
- Changing email address

**Allowed during impersonation:**

- Viewing dashboards
- Reading cases/messages
- Viewing billing history
- Browsing expert profiles

## Environment Variables Checklist

```env
# Required — Server
WORKOS_API_KEY=sk_live_...              # WorkOS secret key
clientId=client_...             # WorkOS client ID
WORKOS_COOKIE_PASSWORD=...              # Min 32 chars, session encryption
WORKOS_REDIRECT_URI=https://balo.expert/callback
WORKOS_WEBHOOK_SECRET=whsec_...         # Webhook signature secret

# Development
WORKOS_API_KEY=sk_test_...              # Test key for dev/staging
WORKOS_REDIRECT_URI=http://localhost:3000/callback
```

**Never commit API keys.** Use `.env.local` for development, environment variables in Vercel/Railway for production.
