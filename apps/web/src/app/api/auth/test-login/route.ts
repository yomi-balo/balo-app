import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { usersRepository } from '@balo/db';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';

export const dynamic = 'force-dynamic';

/**
 * E2E-only session seeding harness (WorkOS is bypassed). Mints an iron-session
 * cookie for a deterministic, always-`user`-role test account in a chosen onboarding
 * state so Playwright can exercise the middleware onboarding gate without a real auth
 * provider.
 *
 * SECURITY: this route is INERT in production. It refuses every request unless
 * `E2E_TEST_AUTH === '1'` AND `NODE_ENV !== 'production'` — the guard is the first
 * statement in the handler, so it can never mint a session in prod. The request body
 * cannot select an identity or a role: the email is DERIVED from the requested state
 * on a fixed `@balo.test` domain (never collides with a real account), and the minted
 * session's `platformRole` is HARDCODED to `'user'`. If the derived account somehow
 * resolves to an elevated row, we refuse rather than mint.
 *
 * NOTE: the deployment-agnostic, secret-gated redesign of this guard
 * (`E2E_TEST_SECRET` → 404/401/200, timing-safe) plus the CI harness ship in BAL-363,
 * not here. This interim `NODE_ENV` guard is intentionally left untouched by BAL-361.
 */
function isE2ETestLoginEnabled(): boolean {
  return process.env.E2E_TEST_AUTH === '1' && process.env.NODE_ENV !== 'production';
}

// Body cannot carry an email/firstName/role — only the onboarding state to seed.
const testLoginSchema = z.object({
  onboardingCompleted: z.boolean().default(false),
});

/** Fixed test identities on a domain that can never belong to a real Balo user. */
function deriveTestEmail(onboardingCompleted: boolean): string {
  return onboardingCompleted ? 'onboarded-e2e@balo.test' : 'unonboarded-e2e@balo.test';
}

type ResolveResult =
  | {
      ok: true;
      user: Awaited<ReturnType<typeof usersRepository.update>>;
      companyId: string;
      companyName: string;
      companyRole: 'owner' | 'admin' | 'member';
    }
  | { ok: false; reason: 'elevated_role' };

/**
 * Upsert a deterministic test user keyed on a DERIVED email, reusing the standard
 * `createWithWorkspace` transaction so the user has a real personal-workspace
 * company/membership. Refuses (before any mutation) if the derived account resolves
 * to a non-`user` row — belt-and-suspenders against escalation.
 */
async function resolveTestUser(onboardingCompleted: boolean): Promise<ResolveResult> {
  const email = deriveTestEmail(onboardingCompleted);
  const existing = await usersRepository.findByEmail(email);

  if (existing) {
    // Never operate on anything but a plain 'user' row — refuse before mutating.
    if (existing.platformRole !== 'user') {
      return { ok: false, reason: 'elevated_role' };
    }
    const user = await usersRepository.update(existing.id, { onboardingCompleted });
    const withCompany = await usersRepository.findWithCompany(user.id);
    const membership = withCompany?.companyMemberships?.[0];
    if (!membership) {
      throw new Error('test-login: resolved user has no company membership');
    }
    return {
      ok: true,
      user,
      companyId: membership.company.id,
      companyName: membership.company.name,
      companyRole: membership.role,
    };
  }

  const created = await usersRepository.createWithWorkspace({
    workosId: `e2e_${crypto.randomUUID()}`,
    email,
    firstName: 'E2E',
    lastName: 'Test',
    avatarUrl: null,
    emailVerified: true,
    activeMode: 'client',
    onboardingCompleted,
  });

  return {
    ok: true,
    user: created.user,
    companyId: created.company.id,
    companyName: created.company.name,
    companyRole: created.membership.role,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isE2ETestLoginEnabled()) {
    return new NextResponse('Not Found', { status: 404 });
  }

  try {
    const body: unknown = await request.json();
    const parsed = testLoginSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { onboardingCompleted } = parsed.data;
    const resolved = await resolveTestUser(onboardingCompleted);
    if (!resolved.ok) {
      // Derived account is not a plain 'user' — never mint an elevated session.
      return NextResponse.json({ error: 'refused' }, { status: 400 });
    }

    const sessionUser: SessionUser = {
      id: resolved.user.id,
      email: resolved.user.email,
      firstName: resolved.user.firstName,
      lastName: resolved.user.lastName,
      avatarUrl: resolved.user.avatarUrl ?? null,
      activeMode: 'client',
      onboardingCompleted: resolved.user.onboardingCompleted,
      // HARDCODED — the harness never mints anything but a plain user session.
      platformRole: 'user',
      companyId: resolved.companyId,
      companyName: resolved.companyName,
      companyRole: resolved.companyRole,
    };

    const session = await getSession();
    session.user = sessionUser;
    await session.save();

    return NextResponse.json({ ok: true, userId: sessionUser.id, onboardingCompleted });
  } catch (error) {
    log.error('E2E test-login failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json({ error: 'test-login failed' }, { status: 500 });
  }
}
