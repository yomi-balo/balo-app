---
name: workos-auth
description: WorkOS AuthKit authentication patterns for the Balo marketplace. Use when implementing login, signup, session handling, protected routes, role-based access, middleware, onboarding flows, Server Action security, admin impersonation, or WorkOS webhook handling. Balo uses custom UI (not hosted AuthKit) to render auth modals in-context. Covers both Next.js frontend and Fastify API authentication patterns.
---

# WorkOS Auth — Balo Platform

## Architecture Overview

**WorkOS handles authentication (identity). Balo handles authorization (permissions) and user data.**

```
WorkOS                              Balo (Supabase)
├── Identity verification           ├── users table (platformRole, activeMode)
├── Email + Password                ├── expert_profiles table
├── OAuth (Google, Microsoft)       ├── companies table + company_members
├── MFA enrollment                  ├── agencies table + agency_members
├── Session tokens (JWT)            └── onboardingCompleted flag
└── User metadata (role cache)
```

WorkOS is NOT the source of truth for user data. Balo's database is the source of truth. WorkOS user metadata caches minimal info for quick session access.

## Auth Model

Authorization is **relationship-derived**, not stored in a single role field:

| Question                          | Answer source                                         |
| --------------------------------- | ----------------------------------------------------- |
| Is this user a platform admin?    | `users.platformRole` (`user`, `admin`, `super_admin`) |
| What mode are they viewing in?    | `users.activeMode` (`client`, `expert`)               |
| What can they do in this company? | `company_members.role` (`owner`, `admin`, `member`)   |
| What can they do in this agency?  | `agency_members.role` (`owner`, `admin`, `expert`)    |
| Are they an approved expert?      | `expert_profiles` exists + `approvedAt` is set        |
| What kind of expert?              | `expert_profiles.type` (`freelancer`, `agency`)       |

A single user can be a company admin, agency expert, and platform admin simultaneously. `activeMode` controls which UI they see.

## Critical: Custom UI, Not Hosted AuthKit

Balo uses **custom UI via WorkOS headless APIs**. Not the hosted AuthKit redirect flow.

**Why:** Users browse expert profiles unauthenticated. When they try to book/message, a login modal appears in-context. After auth, they continue their flow — no page redirect, no lost state. This is critical for marketplace conversion.

**How it works:**

1. User clicks "Book Consultation" on expert profile
2. `<AuthModal />` opens as overlay (not a page redirect)
3. Form calls WorkOS APIs via Server Actions (email/password, OAuth)
4. On success → set session cookie → close modal → user continues flow
5. If new user → after completing current action, redirect to `/onboarding`

**What you build (not WorkOS):** Email/password forms, OAuth buttons, MFA challenge screen, password reset flow, all error/loading states.

## SDK Setup

```typescript
// apps/web/src/lib/auth/config.ts
import { WorkOS } from '@workos-inc/node';

let _workos: WorkOS;
export function getWorkOS(): WorkOS {
  if (!_workos) {
    _workos = new WorkOS(process.env.WORKOS_API_KEY!);
  }
  return _workos;
}

export const clientId = process.env.WORKOS_CLIENT_ID!;

export const sessionConfig = {
  password: process.env.WORKOS_COOKIE_PASSWORD!,
  cookieName: 'balo_session',
  cookieOptions: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: 60 * 60 * 24 * 7, // 7 days
  },
};
```

## Environment Variables

```env
WORKOS_API_KEY=sk_live_...          # Secret key (server only, NEVER expose)
WORKOS_CLIENT_ID=client_...         # Client ID (can be public)
WORKOS_COOKIE_PASSWORD=...          # Min 32 chars, encrypts session cookie
                                    # Generate: openssl rand -base64 32
WORKOS_REDIRECT_URI=https://balo.expert/api/auth/callback
WORKOS_WEBHOOK_SECRET=whsec_...     # For webhook signature verification
```

## Decision Tree

**Building auth modal / login forms?** → Read [references/custom-ui-flows.md](references/custom-ui-flows.md)
— Contains: `signUp`, `signIn` Server Action implementations, `<AuthModal>` component, OAuth callback route (`/callback`), full onboarding flow with code

**Adding route protection or middleware?** → Read [references/protected-routes.md](references/protected-routes.md)
— Contains: `withAuth()` full implementation + role variants, `requireAuth` Fastify plugin, middleware code, session management (`setAuthSession`, `getSession`, `refreshSessionIfNeeded`)

**Handling webhooks from WorkOS?** → Read [references/webhooks-sessions.md](references/webhooks-sessions.md)
— Contains: WorkOS webhook endpoint, event handlers, sign-out (simple + full revocation), admin impersonation (`startImpersonation`, `stopImpersonation`)

**Building onboarding flow?** → Read [references/custom-ui-flows.md](references/custom-ui-flows.md)
— Contains: full onboarding step sequence, `completeOnboarding` Server Action, WorkOS metadata caching

## Session Shape

```typescript
// apps/web/src/lib/auth/session.ts
interface SessionUser {
  id: string; // Balo user UUID
  email: string;
  firstName: string | null;
  lastName: string | null;
  activeMode: 'client' | 'expert';

  // Company context (always present — personal workspace or real company)
  companyId: string;
  companyName: string;
  companyRole: 'owner' | 'admin' | 'member';

  // Expert context (only if user has expert profile)
  expertProfileId?: string;
  verticalId?: string;
}

interface SessionData {
  user?: SessionUser;
  accessToken?: string;
  refreshToken?: string;
}
```

## Session Helpers

These helpers already exist in `apps/web/src/lib/auth/session.ts` — use them directly rather than calling `getSession()` and manually destructuring:

```typescript
// Returns null if not authenticated
getCurrentUser(): Promise<SessionUser | null>

// Throws 'Unauthorized' if not authenticated — for use in withAuth()-wrapped actions
// Also throws 'Onboarding not completed' if !user.onboardingCompleted
requireUser(): Promise<SessionUser>

// Like requireUser(), but also asserts user.activeMode === 'expert' and expertProfileId exists
// Throws 'Expert profile required' if not
requireExpert(): Promise<SessionUser & { expertProfileId: string }>

// Returns { companyId, companyName, companyRole } for the current user's active company context
// Throws if not authenticated or no company membership found
getCompanyContext(): Promise<{ companyId: string; companyName: string; companyRole: string }>
```

## Onboarding Redirect: Where the Check Lives

The `!onboardingCompleted` check runs in **two places**, and both are required:

**1. Middleware** (UX layer — handles page navigations):

```typescript
// apps/web/middleware.ts
if (!session.user.onboardingCompleted && pathname !== ONBOARDING_ROUTE) {
  return NextResponse.redirect(new URL('/onboarding', req.url));
}
```

This catches direct URL navigation. But middleware does NOT protect Server Actions.

**2. `requireUser()` helper** (security layer — handles Server Actions):

```typescript
// apps/web/src/lib/auth/session.ts
export async function requireUser(): Promise<SessionUser> {
  const session = await getSession();
  if (!session?.user?.id) throw new Error('Unauthorized');
  if (!session.user.onboardingCompleted) throw new Error('Onboarding not completed');
  return session.user;
}
```

This ensures no Server Action can be invoked by a user who bypassed the onboarding redirect (e.g., by posting directly to the action endpoint).

**Rule:** Use `withAuth(async (session, ...) => requireUser())` pattern, or call `requireUser()` at the top of any action that should require completed onboarding. The sign-up and onboarding wizard actions are the only Server Actions that should call `getSession()` directly without the onboarding check.

## Admin Impersonation

Admins can impersonate any user for debugging. The original admin session is preserved in a separate cookie and restored on exit. Full implementation in [references/webhooks-sessions.md](references/webhooks-sessions.md).

Key rules:

- Only `platformRole: 'admin'` or `super_admin'` can start impersonation
- Session carries `isImpersonating: true` flag during impersonation
- Destructive actions (payments, password change, account deletion, email change) must check `session.isImpersonating` and throw — `withAuth()` blocks these by default unless `{ allowImpersonation: true }` is passed
- Impersonation cookie has a 1-hour max-age (not 7 days like normal sessions)

## Key Rules

### NEVER Do

- ❌ Use hosted AuthKit redirect (breaks in-context flow)
- ❌ Trust middleware alone for auth — Server Actions bypass middleware entirely
- ❌ Expose `WORKOS_API_KEY` to the client
- ❌ Store role only in WorkOS — Balo's database is source of truth
- ❌ Use a single "role" field for auth — authorization is relationship-derived (see Auth Model above)
- ❌ Let users access the app without completing onboarding
- ❌ Skip webhook signature verification
- ❌ Use `drizzle-kit push` for migration (see drizzle-schema skill)

### ALWAYS Do

- ✅ Authenticate in EVERY Server Action (use `withAuth()` wrapper)
- ✅ Authenticate in EVERY Fastify route (use `requireAuth` preHandler)
- ✅ Validate inputs with Zod in all auth endpoints
- ✅ Verify webhook signatures with `workos.webhooks.constructEvent()`
- ✅ Redirect to `/onboarding` if `!onboardingCompleted`
- ✅ Create user + company + membership in a single transaction on first signup
- ✅ Cache activeMode in WorkOS user metadata after onboarding

## `withAuth()` — Server Action Pattern (most-used daily pattern)

Every Server Action that requires authentication MUST use this wrapper. Server Actions bypass middleware — there is no fallback.

```typescript
// ✅ CORRECT
'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';

export const createCase = withAuth(async (session, input: CreateCaseInput) => {
  // session.user is guaranteed here — withAuth throws 'Unauthorized' if not
  const validated = createCaseSchema.parse(input);
  return db
    .insert(cases)
    .values({ creatorId: session.user.id, ...validated })
    .returning();
});

// ❌ WRONG — middleware does NOT protect Server Actions
('use server');
export async function createCase(input: CreateCaseInput) {
  // No auth check — callable by anyone who sends a POST to the action URL
}
```

Variants for role-based guards:

- `withPlatformRole('admin', action)` — admin-only actions
- `withExpert(action)` — expert-only, guarantees `session.user.expertProfileId`

Full implementation → [references/protected-routes.md](references/protected-routes.md)

## `requireAuth` — Fastify API Pattern

Every Fastify route uses this preHandler. It verifies the WorkOS Bearer token and loads `req.user`.

```typescript
// ✅ CORRECT
fastify.get('/cases', { preHandler: [fastify.requireAuth] }, async (req) => {
  return db.query.cases.findMany({ where: eq(cases.creatorId, req.user!.id) });
});

// For admin routes
fastify.delete(
  '/users/:id',
  {
    preHandler: [fastify.requireAuth, fastify.requirePlatformRole(['admin', 'super_admin'])],
  },
  handler
);
```

Full implementation → [references/protected-routes.md](references/protected-routes.md)

## Token Refresh

WorkOS access tokens expire (~1 hour). Token refresh is handled automatically in Next.js middleware via `refreshSessionIfNeeded()`, which calls `authenticateWithRefreshToken` and re-issues the session cookie transparently.

**You do not need to handle token refresh manually in Server Actions or components.** Middleware handles it on every request. If a refresh fails (e.g. refresh token itself has expired), the session is cleared and the user is redirected to login.

The 7-day cookie lifetime means users stay logged in even as access tokens rotate. Full implementation → [references/protected-routes.md](references/protected-routes.md)

## `activeMode` Switch Flow

Users can be both clients and experts. `activeMode` controls which UI they see. Switching modes is a Server Action that updates the DB and re-issues the session cookie.

```typescript
// apps/web/app/actions/switch-mode.ts
'use server';
import 'server-only';
import { withAuth } from '@/lib/auth/with-auth';
import { setAuthSession } from '@/lib/auth/session';
import { db } from '@balo/db';
import { users } from '@balo/db/schema';
import { eq } from 'drizzle-orm';

export const switchActiveMode = withAuth(async (session, newMode: 'client' | 'expert') => {
  if (newMode === 'expert' && !session.user.expertProfileId) {
    throw new Error('No approved expert profile — cannot switch to expert mode');
  }

  // Update DB
  await db.update(users).set({ activeMode: newMode }).where(eq(users.id, session.user.id));

  // Re-issue session cookie with updated mode
  await setAuthSession({
    ...session,
    user: { ...session.user, activeMode: newMode },
  });

  return { success: true };
});
```

**Important:** Switching to expert mode requires an approved `expert_profiles` row (`approvedAt` is not null). Guard against unapproved experts switching prematurely.

## Company Context: Personal Workspace vs Real Company

Every user has a `companyId` in their session — always. Here's why:

- **On signup:** A personal workspace company is auto-created (`companies.isPersonal = true`). This gives every user a company context so the auth model is uniform — no special-casing for "solo users".
- **Personal workspace name:** Defaults to `"{firstName}'s Workspace"`.
- **Real company:** Created explicitly when a user creates or joins a team. At that point, the session's `companyId` switches to the real company.
- **The distinction matters for:** billing (credits belong to the company, not the user), member permissions, and the company settings UI (personal workspaces don't show member management).

`companies.isPersonal` is the flag. Personal workspaces have `isPersonal = true` and exactly one member (the owner).
