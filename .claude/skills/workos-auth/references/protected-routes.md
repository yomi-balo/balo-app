# Protected Routes — Balo

## CRITICAL: Server Actions Bypass Middleware

Next.js Server Actions are publicly accessible POST endpoints. They **completely bypass middleware**. Auth checks in middleware will NOT protect Server Actions.

**CVE-2025-29927** confirmed this attack surface — attackers could bypass middleware via crafted headers. This reinforces: never rely solely on middleware for auth.

**Rule: Every Server Action must call `withAuth()` or `getSession()` directly.**

## The `withAuth()` Wrapper

Every Server Action that requires authentication MUST use this wrapper. No exceptions.

```typescript
// apps/web/lib/auth/with-auth.ts
import 'server-only';
import { getSession, type BaloSession } from './session';

type AuthenticatedAction<TArgs extends any[], TReturn> = (
  session: BaloSession,
  ...args: TArgs
) => Promise<TReturn>;

export function withAuth<TArgs extends any[], TReturn>(
  action: AuthenticatedAction<TArgs, TReturn>
) {
  return async (...args: TArgs): Promise<TReturn> => {
    const session = await getSession();
    if (!session?.user?.id) {
      throw new Error('Unauthorized');
    }
    return action(session, ...args);
  };
}
```

### Usage

```typescript
// ✅ CORRECT — always use withAuth
'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';

export const createCase = withAuth(async (session, input: CreateCaseInput) => {
  const validated = createCaseSchema.parse(input);

  // session.user is guaranteed to exist here
  const newCase = await db
    .insert(cases)
    .values({
      creatorId: session.user.id,
      title: validated.title,
    })
    .returning();

  return newCase;
});
```

```typescript
// ❌ WRONG — relies on middleware, no auth check
'use server';
export async function createCase(input: CreateCaseInput) {
  // If someone POSTs directly, this runs with no user context!
  const newCase = await db
    .insert(cases)
    .values({
      title: input.title,
    })
    .returning();
  return newCase;
}
```

## Role-Based `withAuth` Variants

```typescript
// apps/web/lib/auth/with-auth.ts (extended)

export function withRole<TArgs extends any[], TReturn>(
  requiredRole: UserRole | UserRole[],
  action: AuthenticatedAction<TArgs, TReturn>
) {
  return withAuth(async (session, ...args: TArgs) => {
    const roles = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
    if (!roles.includes(session.user.role as UserRole)) {
      throw new Error('Forbidden');
    }
    return action(session, ...args);
  });
}

export function withExpert<TArgs extends any[], TReturn>(
  action: (
    session: BaloSession & { user: { expertProfileId: string } },
    ...args: TArgs
  ) => Promise<TReturn>
) {
  return withRole('expert', async (session, ...args: TArgs) => {
    if (!session.user.expertProfileId) {
      throw new Error('Expert profile not found');
    }
    return action(session as any, ...args);
  });
}

// Usage
export const updateAvailability = withExpert(async (session, slots: TimeSlot[]) => {
  // session.user.expertProfileId is guaranteed here
  await db
    .update(expertProfiles)
    .set({ availability: slots })
    .where(eq(expertProfiles.id, session.user.expertProfileId));
});
```

## Next.js Middleware

Middleware handles two concerns: session refresh and onboarding redirect. **NOT primary auth.**

```typescript
// apps/web/middleware.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie, refreshSessionIfNeeded } from '@/lib/auth/session';

const PUBLIC_ROUTES = [
  '/',
  '/experts',
  '/experts/(.*)',
  '/login',
  '/signup',
  '/callback',
  '/api/webhooks/(.*)',
];

const ONBOARDING_ROUTE = '/onboarding';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Public routes — no auth needed
  if (PUBLIC_ROUTES.some((pattern) => new RegExp(`^${pattern}$`).test(pathname))) {
    return NextResponse.next();
  }

  // Get session
  const session = await getSessionFromCookie(req);

  // No session → redirect to login
  if (!session) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('returnTo', pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Session expiring → refresh
  const refreshedResponse = await refreshSessionIfNeeded(session, req);

  // Onboarding check — role not set yet
  if (!session.user.role && pathname !== ONBOARDING_ROUTE) {
    return NextResponse.redirect(new URL(ONBOARDING_ROUTE, req.url));
  }

  // Already onboarded, trying to visit /onboarding
  if (session.user.role && pathname === ONBOARDING_ROUTE) {
    return NextResponse.redirect(new URL('/dashboard', req.url));
  }

  return refreshedResponse || NextResponse.next();
}

export const config = {
  matcher: [
    // Match all routes except static files and API routes that handle their own auth
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
```

**Remember:** This middleware is a UX convenience (redirects, session refresh). It is NOT a security boundary. Every Server Action and API route authenticates independently.

## Session Management

```typescript
// apps/web/lib/auth/session.ts
import 'server-only';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';
import { workos, WORKOS_CLIENT_ID } from '@/lib/workos';

const SECRET = new TextEncoder().encode(process.env.WORKOS_COOKIE_PASSWORD!);
const COOKIE_NAME = 'balo_session';

export interface BaloSession {
  user: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string | null;
    activeMode: 'client' | 'expert';
    companyId: string;
    companyName: string;
    companyRole: string;
    expertProfileId?: string;
    verticalId?: string;
  };
  accessToken: string;
  refreshToken: string;
}

export async function setAuthSession(session: BaloSession): Promise<void> {
  const token = await new SignJWT({ session })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('7d')
    .sign(SECRET);

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  });
}

export async function getSession(): Promise<BaloSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, SECRET);
    return (payload as any).session as BaloSession;
  } catch {
    return null;
  }
}

export async function clearSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function refreshSessionIfNeeded(
  session: BaloSession,
  req: NextRequest
): Promise<NextResponse | null> {
  // Check if access token is about to expire
  // If so, use refresh token to get new tokens
  try {
    const result = await workos.userManagement.authenticateWithRefreshToken({
      clientId: WORKOS_CLIENT_ID,
      refreshToken: session.refreshToken,
    });

    // Update session with new tokens
    session.accessToken = result.accessToken;
    session.refreshToken = result.refreshToken;

    const response = NextResponse.next();
    // Set updated cookie on response
    const token = await new SignJWT({ session })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('7d')
      .sign(SECRET);

    response.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    });

    return response;
  } catch {
    // Refresh failed — session is invalid
    return null;
  }
}
```

## Fastify API Authentication

The Fastify API (`apps/api`) uses a preHandler hook to verify the WorkOS access token.

```typescript
// apps/api/src/plugins/auth.ts
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { workos } from '@/lib/workos';
import { db } from '@/db/client';
import { users } from '@/db/schema';
import { eq } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    user: {
      id: string;
      workosUserId: string;
      email: string;
      role: string;
    } | null;
  }
}

async function authPlugin(fastify: FastifyInstance) {
  fastify.decorateRequest('user', null);

  // preHandler that verifies JWT and loads user
  fastify.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization header' });
    }

    const token = authHeader.slice(7);

    try {
      // Verify the WorkOS access token
      const { sub: workosUserId } = await workos.userManagement.getJwksUrl(token);
      // Note: actual JWT verification uses JWKS from WorkOS

      // Load Balo user
      const user = await db.query.users.findFirst({
        where: eq(users.workosUserId, workosUserId),
      });

      if (!user) {
        return reply.status(401).send({ error: 'User not found' });
      }

      req.user = {
        id: user.id,
        workosUserId: user.workosUserId,
        email: user.email,
        role: user.role!,
      };
    } catch (error) {
      return reply.status(401).send({ error: 'Invalid token' });
    }
  });

  // Role check decorator
  fastify.decorate('requireRole', (roles: string[]) => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.user) {
        return reply.status(401).send({ error: 'Not authenticated' });
      }
      if (!roles.includes(req.user.role)) {
        return reply.status(403).send({ error: 'Insufficient permissions' });
      }
    };
  });
}

export default fp(authPlugin);
```

### Using in Routes

```typescript
// apps/api/src/routes/cases.ts
import { FastifyInstance } from 'fastify';

export async function caseRoutes(fastify: FastifyInstance) {
  // Protected route — any authenticated user
  fastify.get(
    '/cases',
    {
      preHandler: [fastify.requireAuth],
    },
    async (req) => {
      return db.query.cases.findMany({
        where: eq(cases.creatorId, req.user!.id),
      });
    }
  );

  // Protected route — experts only
  fastify.post(
    '/cases/:id/accept',
    {
      preHandler: [fastify.requireAuth, fastify.requireRole(['expert'])],
    },
    async (req) => {
      // req.user is guaranteed to be an expert
    }
  );
}
```

## Authorization Patterns (Beyond Auth)

Authentication = who are you? Authorization = can you do this?

```typescript
// Always check resource ownership, not just "is logged in"
export const updateCase = withAuth(async (session, caseId: string, input: unknown) => {
  const validated = updateCaseSchema.parse(input);

  // Check user is a participant in this case
  const participation = await db.query.caseParticipants.findFirst({
    where: and(eq(caseParticipants.caseId, caseId), eq(caseParticipants.userId, session.user.id)),
  });

  if (!participation) {
    throw new Error('You do not have access to this case');
  }

  // Now safe to update
  return db.update(cases).set(validated).where(eq(cases.id, caseId)).returning();
});
```

## Public vs Protected Route Summary

| Path Pattern          | Auth Required      | Notes                    |
| --------------------- | ------------------ | ------------------------ |
| `/`                   | No                 | Landing page             |
| `/experts`            | No                 | Browse marketplace       |
| `/experts/[id]`       | No                 | Expert profile (public)  |
| `/experts/[id]/book`  | **Triggers modal** | Auth modal when booking  |
| `/callback`           | No                 | OAuth callback handler   |
| `/api/webhooks/*`     | **Webhook secret** | Signature verification   |
| `/onboarding`         | Yes                | Redirect if role is null |
| `/dashboard`          | Yes                | Client dashboard         |
| `/expert/dashboard`   | Yes + Expert role  | Expert dashboard         |
| `/admin/*`            | Yes + Admin role   | Admin panel              |
| `/api/v1/*` (Fastify) | Yes (Bearer token) | API routes               |
