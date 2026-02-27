---
name: workos-auth
description: WorkOS AuthKit authentication patterns for the Balo marketplace. Use when implementing login, signup, session handling, protected routes, role-based access, middleware, onboarding flows, Server Action security, admin impersonation, or WorkOS webhook handling. Balo uses custom UI (not hosted AuthKit) to render auth modals in-context. Covers both Next.js frontend and Fastify API authentication patterns.
---

# WorkOS Auth — Balo Platform

## Architecture Overview

**WorkOS handles authentication (identity). Balo handles authorization (permissions) and user data.**

```
WorkOS                              Balo (Supabase)
├── Identity verification           ├── users table (role, profile)
├── Email + Password                ├── expert_profiles table
├── OAuth (Google, GitHub)          ├── companies table
├── MFA enrollment                  ├── company_members table
├── Session tokens (JWT)            └── onboarding_completed flag
└── User metadata (role cache)
```

WorkOS is NOT the source of truth for user data. Supabase `users.role` is the source of truth. WorkOS metadata caches the role for quick session access.

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
// packages/shared/src/lib/workos.ts
import { WorkOS } from '@workos-inc/node';

export const workos = new WorkOS(process.env.WORKOS_API_KEY!);
export const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID!;
```

## Environment Variables

```env
WORKOS_API_KEY=sk_live_...          # Secret key (server only, NEVER expose)
WORKOS_CLIENT_ID=client_...         # Client ID (can be public)
WORKOS_COOKIE_PASSWORD=...          # Min 32 chars, encrypts session cookie
WORKOS_REDIRECT_URI=https://balo.expert/callback
WORKOS_WEBHOOK_SECRET=whsec_...     # For webhook signature verification
```

## User Roles

```typescript
type UserRole = 'client' | 'expert' | 'admin' | 'super_admin';
```

**Role is NULL after signup.** Set during onboarding when user chooses "I'm a Client" or "I'm an Expert".

## Decision Tree

**Building auth modal / login forms?** → Read [references/custom-ui-flows.md](references/custom-ui-flows.md)
**Adding route protection or middleware?** → Read [references/protected-routes.md](references/protected-routes.md)
**Handling webhooks from WorkOS?** → Read [references/webhooks-sessions.md](references/webhooks-sessions.md)
**Building onboarding flow?** → Read [references/custom-ui-flows.md](references/custom-ui-flows.md)

## Session Shape

```typescript
interface BaloSession {
  user: {
    id: string; // Balo user UUID
    email: string;
    firstName: string | null;
    lastName: string | null;
    activeMode: 'client' | 'expert';
    companyId: string; // Current company context
    companyName: string;
    companyRole: string; // Role within company
    expertProfileId?: string; // If expert
    verticalId?: string; // If expert
  };
  accessToken: string; // WorkOS JWT
  refreshToken: string; // WorkOS refresh token
}
```

## Key Rules

### NEVER Do

- ❌ Use hosted AuthKit redirect (breaks in-context flow)
- ❌ Trust middleware alone for auth — Server Actions bypass middleware entirely
- ❌ Expose `WORKOS_API_KEY` to the client
- ❌ Store role only in WorkOS — Supabase is source of truth
- ❌ Let users access the app without completing onboarding
- ❌ Skip webhook signature verification
- ❌ Use `drizzle-kit push` for migration (see drizzle-schema skill)

### ALWAYS Do

- ✅ Authenticate in EVERY Server Action (use `withAuth()` wrapper)
- ✅ Authenticate in EVERY Fastify route (use `requireAuth` preHandler)
- ✅ Validate inputs with Zod in all auth endpoints
- ✅ Verify webhook signatures with `workos.webhooks.constructEvent()`
- ✅ Redirect to `/onboarding` if `role === null || !onboardingCompleted`
- ✅ Create user + company + membership in a single transaction on first signup
- ✅ Cache role in WorkOS user metadata after onboarding
