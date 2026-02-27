# Custom UI Auth Flows — Balo

## Core Principle

Balo renders all auth UI itself using Shadcn components + WorkOS headless APIs via Server Actions. The user never leaves the page they're on. Auth happens in an overlay modal.

## WorkOS SDK Methods (Custom UI)

```typescript
import { getWorkOS, clientId } from '@/lib/auth/config';

// Create account
getWorkOS().userManagement.createUser({ email, password, firstName, lastName });

// Email + password login
getWorkOS().userManagement.authenticateWithPassword({ clientId, email, password });

// Exchange auth code (OAuth callback)
getWorkOS().userManagement.authenticateWithCode({ code, clientId });

// OAuth — generate authorization URL
getWorkOS().userManagement.getAuthorizationUrl({
  provider: 'GoogleOAuth', // or 'MicrosoftOAuth'
  clientId: clientId,
  redirectUri: process.env.WORKOS_REDIRECT_URI!,
});

// Password reset
getWorkOS().userManagement.sendPasswordResetEmail({ email, passwordResetUrl: '...' });
getWorkOS().userManagement.resetPassword({ token, newPassword });

// Email verification
getWorkOS().userManagement.sendVerificationEmail({ userId });
getWorkOS().userManagement.verifyEmail({ userId, code });

// Refresh session
getWorkOS().userManagement.authenticateWithRefreshToken({ clientId, refreshToken });

// Get/update user metadata
getWorkOS().userManagement.getUser(workosUserId);
getWorkOS().userManagement.updateUser(workosUserId, { metadata: { activeMode: 'expert' } });
```

## AuthModal Component Pattern

```typescript
// packages/ui/src/components/auth/auth-modal.tsx
'use client';

import { Dialog, DialogContent } from '@/components/ui/dialog';
import { useState } from 'react';
import { SignInForm } from './sign-in-form';
import { SignUpForm } from './sign-up-form';
import { ForgotPasswordForm } from './forgot-password-form';

type AuthView = 'sign-in' | 'sign-up' | 'forgot-password';

interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;          // Called after successful auth
  defaultView?: AuthView;
  /** Context to preserve — e.g. the booking the user was making */
  returnContext?: Record<string, unknown>;
}

export function AuthModal({
  open,
  onClose,
  onSuccess,
  defaultView = 'sign-in',
  returnContext,
}: AuthModalProps) {
  const [view, setView] = useState<AuthView>(defaultView);

  const handleAuthSuccess = () => {
    // Session cookie is already set by the Server Action
    // Close modal, user continues where they were
    onSuccess();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        {view === 'sign-in' && (
          <SignInForm
            onSuccess={handleAuthSuccess}
            onSwitchToSignUp={() => setView('sign-up')}
            onForgotPassword={() => setView('forgot-password')}
          />
        )}
        {view === 'sign-up' && (
          <SignUpForm
            onSuccess={handleAuthSuccess}
            onSwitchToSignIn={() => setView('sign-in')}
          />
        )}
        {view === 'forgot-password' && (
          <ForgotPasswordForm
            onBack={() => setView('sign-in')}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
```

## Sign Up Server Action

```typescript
// apps/web/app/(auth)/actions/sign-up.ts
'use server';
import 'server-only';

import { z } from 'zod';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { setAuthSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { users, companies, companyMembers } from '@balo/db/schema';

const signUpSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
});

export async function signUp(input: z.infer<typeof signUpSchema>) {
  const validated = signUpSchema.parse(input);

  // 1. Create user in WorkOS
  const workosUser = await getWorkOS().userManagement.createUser({
    email: validated.email,
    password: validated.password,
    firstName: validated.firstName,
    lastName: validated.lastName,
  });

  // 2. Authenticate to get session tokens
  const authResult = await getWorkOS().userManagement.authenticateWithPassword({
    clientId: clientId,
    email: validated.email,
    password: validated.password,
  });

  // 3. Create Balo user + personal workspace in transaction
  const result = await db.transaction(async (tx) => {
    const [newUser] = await tx
      .insert(users)
      .values({
        workosId: workosUser.id,
        email: workosUser.email,
        firstName: workosUser.firstName,
        lastName: workosUser.lastName,
        // activeMode defaults to 'client', updated during onboarding
        onboardingCompleted: false,
      })
      .returning();

    const workspaceName = workosUser.firstName
      ? `${workosUser.firstName}'s Workspace`
      : 'My Workspace';

    const [newCompany] = await tx
      .insert(companies)
      .values({
        name: workspaceName,
        isPersonal: true,
        creditBalance: 0,
      })
      .returning();

    await tx.insert(companyMembers).values({
      companyId: newCompany.id,
      userId: newUser.id,
      role: 'owner',
    });

    return { user: newUser, company: newCompany };
  });

  // 4. Set session cookie
  await setAuthSession({
    user: {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName,
      lastName: result.user.lastName,
      activeMode: 'client',
      companyId: result.company.id,
      companyName: result.company.name,
      companyRole: 'owner',
    },
    accessToken: authResult.accessToken,
    refreshToken: authResult.refreshToken,
  });

  return { success: true, needsOnboarding: true };
}
```

## Sign In Server Action

```typescript
// apps/web/app/(auth)/actions/sign-in.ts
'use server';
import 'server-only';

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { setAuthSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { users, companyMembers, expertProfiles } from '@balo/db/schema';

const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function signIn(input: z.infer<typeof signInSchema>) {
  const validated = signInSchema.parse(input);

  // 1. Authenticate with WorkOS
  const authResult = await getWorkOS().userManagement.authenticateWithPassword({
    clientId: clientId,
    email: validated.email,
    password: validated.password,
  });

  // 2. Find Balo user
  const user = await db.query.users.findFirst({
    where: eq(users.workosUserId, authResult.user.id),
  });

  if (!user) {
    throw new Error('User account not found');
  }

  // 3. Load company + expert context
  const membership = await db.query.companyMembers.findFirst({
    where: eq(companyMembers.userId, user.id),
    with: { company: true },
  });

  if (!membership) {
    throw new Error('No company membership found');
  }

  const expertProfile =
    user.activeMode === 'expert'
      ? await db.query.expertProfiles.findFirst({
          where: eq(expertProfiles.userId, user.id),
        })
      : null;

  // 4. Set session
  await setAuthSession({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      activeMode: user.activeMode ?? 'client',
      companyId: membership.company.id,
      companyName: membership.company.name,
      companyRole: membership.role,
      ...(expertProfile && {
        expertProfileId: expertProfile.id,
        verticalId: expertProfile.verticalId,
      }),
    },
    accessToken: authResult.accessToken,
    refreshToken: authResult.refreshToken,
  });

  return {
    success: true,
    needsOnboarding: !user.onboardingCompleted,
  };
}
```

## OAuth Flow (Google, Microsoft)

OAuth requires a redirect, but we minimize disruption:

```typescript
// apps/web/app/(auth)/actions/oauth.ts
'use server';
import 'server-only';

import { redirect } from 'next/navigation';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { cookies } from 'next/headers';

type OAuthProvider = 'GoogleOAuth' | 'MicrosoftOAuth';

export async function initiateOAuth(provider: OAuthProvider, returnTo?: string) {
  // Store return path so we can redirect back after OAuth
  if (returnTo) {
    const cookieStore = await cookies();
    cookieStore.set('auth_return_to', returnTo, {
      httpOnly: true,
      secure: true,
      maxAge: 600, // 10 minutes
      sameSite: 'lax',
    });
  }

  const url = getWorkOS().userManagement.getAuthorizationUrl({
    provider,
    clientId: clientId,
    redirectUri: process.env.WORKOS_REDIRECT_URI!,
  });

  redirect(url);
}
```

```typescript
// apps/web/app/callback/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getWorkOS, clientId } from '@/lib/auth/config';
import { setAuthSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { users, companies, companyMembers, expertProfiles } from '@balo/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', req.url));
  }

  try {
    const authResult = await getWorkOS().userManagement.authenticateWithCode({
      code,
      clientId: clientId,
    });

    const workosUser = authResult.user;

    // Find or create Balo user
    let user = await db.query.users.findFirst({
      where: eq(users.workosUserId, workosUser.id),
    });

    let company;
    let membership;

    if (!user) {
      // New user — create user + workspace in transaction
      const result = await db.transaction(async (tx) => {
        const [newUser] = await tx
          .insert(users)
          .values({
            workosId: workosUser.id,
            email: workosUser.email,
            firstName: workosUser.firstName,
            lastName: workosUser.lastName,
            // activeMode defaults to 'client', updated during onboarding
            onboardingCompleted: false,
          })
          .returning();

        const [newCompany] = await tx
          .insert(companies)
          .values({
            name: `${workosUser.firstName || 'My'}'s Workspace`,
            isPersonal: true,
            creditBalance: 0,
          })
          .returning();

        const [newMembership] = await tx
          .insert(companyMembers)
          .values({
            companyId: newCompany.id,
            userId: newUser.id,
            role: 'owner',
          })
          .returning();

        return { user: newUser, company: newCompany, membership: newMembership };
      });

      user = result.user;
      company = result.company;
      membership = result.membership;
    } else {
      // Existing user
      const membershipResult = await db.query.companyMembers.findFirst({
        where: eq(companyMembers.userId, user.id),
        with: { company: true },
      });
      company = membershipResult!.company;
      membership = membershipResult!;
    }

    const expertProfile =
      user.activeMode === 'expert'
        ? await db.query.expertProfiles.findFirst({
            where: eq(expertProfiles.userId, user.id),
          })
        : null;

    await setAuthSession({
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        activeMode: user.activeMode ?? 'client',
        companyId: company.id,
        companyName: company.name,
        companyRole: membership.role,
        ...(expertProfile && {
          expertProfileId: expertProfile.id,
          verticalId: expertProfile.verticalId,
        }),
      },
      accessToken: authResult.accessToken,
      refreshToken: authResult.refreshToken,
    });

    // Return to where user was, or dashboard
    const cookieStore = await req.cookies;
    const returnTo = cookieStore.get('auth_return_to')?.value;
    const redirectUrl = returnTo || (user.onboardingCompleted ? '/dashboard' : '/onboarding');

    const response = NextResponse.redirect(new URL(redirectUrl, req.url));
    response.cookies.delete('auth_return_to');
    return response;
  } catch (error) {
    console.error('Auth callback error:', error);
    return NextResponse.redirect(new URL('/login?error=auth_failed', req.url));
  }
}
```

## Onboarding Flow

After first authentication, users must complete onboarding before accessing the app.

```
1. User authenticates (custom UI modal or OAuth)
   ↓
2. Callback creates users row with onboarding_completed=false
   + Creates personal company + company_members row (every user gets a company context)
   ↓
3. Middleware detects !onboardingCompleted → redirects to /onboarding
   ↓
4. Step 1: Welcome, timezone, preferences
   ↓
5. Step 2: "How will you use Balo?" — sets activeMode
   ↓
6a. CLIENT PATH:
    → Company details (optional)
    → Set activeMode='client', onboardingCompleted=true
    → Redirect to /dashboard
   ↓
6b. EXPERT PATH:
    → Multi-step: skills, bio, hourly rate, calendar
    → Set activeMode='expert', onboardingCompleted=true
    → Create expert_profiles row (approvedAt=null — pending approval)
    → Cache { activeMode: 'expert' } in WorkOS user metadata
    → Redirect to /expert/dashboard
```

**Note:** Users can later switch modes via the mode switcher. Choosing "client" during onboarding doesn't prevent becoming an expert later (and vice versa). The onboarding choice sets their initial default.

```typescript
// apps/web/app/(auth)/actions/complete-onboarding.ts
'use server';
import 'server-only';

import { z } from 'zod';
import { withAuth } from '@/lib/auth/with-auth';
import { db } from '@balo/db';
import { users, expertProfiles } from '@balo/db/schema';
import { eq } from 'drizzle-orm';
import { getWorkOS } from '@/lib/auth/config';

const clientOnboardingSchema = z.object({
  activeMode: z.literal('client'),
  companyName: z.string().optional(),
  timezone: z.string(),
});

const expertOnboardingSchema = z.object({
  activeMode: z.literal('expert'),
  headline: z.string().min(1),
  bio: z.string().min(10),
  hourlyRate: z.number().positive(),
  timezone: z.string(),
  verticalId: z.string().uuid(),
  skills: z.array(z.string().uuid()).min(1),
});

const onboardingSchema = z.discriminatedUnion('activeMode', [
  clientOnboardingSchema,
  expertOnboardingSchema,
]);

export const completeOnboarding = withAuth(async (session, input: unknown) => {
  const validated = onboardingSchema.parse(input);

  await db.transaction(async (tx) => {
    // Update user preferences and mark onboarding complete
    await tx
      .update(users)
      .set({
        activeMode: validated.activeMode,
        timezone: validated.timezone,
        onboardingCompleted: true,
      })
      .where(eq(users.id, session.user.id));

    // Create expert profile if expert path (pending approval)
    if (validated.activeMode === 'expert') {
      await tx.insert(expertProfiles).values({
        userId: session.user.id,
        verticalId: validated.verticalId,
        headline: validated.headline,
        bio: validated.bio,
        hourlyRate: validated.hourlyRate,
        type: 'freelancer', // default, can change later
      });
    }
  });

  // Cache activeMode in WorkOS metadata
  const workosUser = await db.query.users.findFirst({
    where: eq(users.id, session.user.id),
    columns: { workosId: true },
  });

  if (workosUser) {
    await getWorkOS().userManagement.updateUser(workosUser.workosId, {
      metadata: { activeMode: validated.activeMode },
    });
  }

  return { success: true, activeMode: validated.activeMode };
});
```

## Using AuthModal in Marketplace Flow

```typescript
// apps/web/app/experts/[id]/book/page.tsx
'use client';

import { useState } from 'react';
import { AuthModal } from '@/components/auth/auth-modal';
import { useSession } from '@/hooks/use-session';

export default function BookExpertPage() {
  const { session, isLoading } = useSession();
  const [showAuth, setShowAuth] = useState(false);

  const handleBookClick = () => {
    if (!session) {
      // User not logged in — show auth modal in-place
      setShowAuth(true);
      return;
    }
    // User logged in — proceed with booking
    proceedWithBooking();
  };

  const handleAuthSuccess = () => {
    // Auth complete, continue the booking flow
    setShowAuth(false);
    proceedWithBooking();
  };

  return (
    <>
      {/* ... expert profile, calendar picker, etc. ... */}
      <button onClick={handleBookClick}>Book Consultation</button>

      <AuthModal
        open={showAuth}
        onClose={() => setShowAuth(false)}
        onSuccess={handleAuthSuccess}
        defaultView="sign-up"
      />
    </>
  );
}
```
