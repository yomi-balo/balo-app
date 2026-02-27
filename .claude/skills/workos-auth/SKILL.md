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
WORKOS_REDIRECT_URI=https://balo.expert/api/auth/callback
WORKOS_WEBHOOK_SECRET=whsec_...     # For webhook signature verification
```

## Decision Tree

**Building auth modal / login forms?** → Read [references/custom-ui-flows.md](references/custom-ui-flows.md)
**Adding route protection or middleware?** → Read [references/protected-routes.md](references/protected-routes.md)
**Handling webhooks from WorkOS?** → Read [references/webhooks-sessions.md](references/webhooks-sessions.md)
**Building onboarding flow?** → Read [references/custom-ui-flows.md](references/custom-ui-flows.md)

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

Session helpers already exist: `getCurrentUser()`, `requireUser()`, `requireExpert()`, `getCompanyContext()` — all in `apps/web/src/lib/auth/session.ts`.

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
