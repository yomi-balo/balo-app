'use server';

import 'server-only';

import { getWorkOS, clientId } from '@/lib/auth/config';
import { getSession } from '@/lib/auth/session';
import { usersRepository, type DomainCaptureResult, type User } from '@balo/db';
import { type AuthResult, mapWorkOSError, AccountExistsError } from '@/lib/auth/errors';
import { resolveLinkedUser, ACCOUNT_EXISTS_MESSAGE } from '@/lib/auth/resolve-identity';
import { verifyEmailSchema, type VerifyEmailFormData } from '@/components/balo/auth/schemas';
import { log } from '@/lib/logging';
import { publishNotificationEvent } from '@/lib/notifications/publish';
import { emitDomainCapture } from '@/lib/analytics/party-domains';
import { trackServerAndFlush, AUTH_SERVER_EVENTS } from '@/lib/analytics/server';
import { runDomainJoinAndEmit } from '@/lib/domain-join/run-domain-join';

export type VerifyEmailInput = VerifyEmailFormData;

interface VerifyEmailResult {
  needsOnboarding: boolean;
  userId: string;
  email: string;
  activeMode: 'client' | 'expert';
  platformRole: 'user' | 'admin' | 'super_admin';
}

export async function verifyEmailAction(
  input: VerifyEmailInput
): Promise<AuthResult<VerifyEmailResult>> {
  // 1. Validate
  const parsed = verifyEmailSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const { pendingAuthToken, code } = parsed.data;

  try {
    // 2. Complete email verification with WorkOS.
    //    Exchanges the pending token + OTP code for real auth tokens.
    const authResponse = await getWorkOS().userManagement.authenticateWithEmailVerification({
      clientId,
      pendingAuthenticationToken: pendingAuthToken,
      code,
    });

    const workosUser = authResponse.user;

    // 3. Resolve the WorkOS identity to a LIVE Balo user (handles double-submit /
    //    retry races AND a workosId churn re-link). BAL-362: build the identity with
    //    emailVerified: true — OTP definitionally PROVES verification, matching the
    //    create path's hardcoded flag. The only reachable conflict is therefore an
    //    existing-row-unverified match → clean account_exists (handled in the catch).
    const resolved = await resolveLinkedUser({
      id: workosUser.id,
      email: workosUser.email,
      emailVerified: true,
    });
    let existingUser: User;
    let isNewUser = false;
    let didRelink = false;
    // BAL-344: the domain auto-capture outcome from the create tx, emitted
    // post-commit below. Non-applicable unless a new user was created here.
    let domainCapture: DomainCaptureResult = { outcome: 'not_applicable' };

    if (resolved) {
      existingUser = resolved.user;
      didRelink = resolved.didRelink;
    } else {
      // Create Balo user + personal workspace in a single transaction.
      // Name is null -- will be collected in onboarding for email sign-ups.
      const created = await usersRepository.createWithWorkspace({
        workosId: workosUser.id,
        email: workosUser.email,
        firstName: workosUser.firstName ?? null,
        lastName: workosUser.lastName ?? null,
        emailVerified: true,
        activeMode: 'client',
      });
      existingUser = created.user;
      isNewUser = true;
      domainCapture = created.domainCapture;
    }

    // 4. Load company membership (always exists — created at signup or recovery above)
    const userWithCompany = await usersRepository.findWithCompany(existingUser.id);
    if (!userWithCompany?.companyMemberships?.[0]) {
      return { success: false, error: 'Account setup incomplete. Please try signing in.' };
    }

    const user = existingUser;
    const membership = userWithCompany.companyMemberships[0];

    // 5. Set session cookie
    const session = await getSession();
    session.user = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarUrl: user.avatarUrl ?? null,
      activeMode: user.activeMode,
      onboardingCompleted: false,
      platformRole: 'user',
      // BAL-350: OTP verification is definitionally an email signup — hardcode
      // 'email' rather than trusting WorkOS (which may report MagicAuth/Password).
      authMethod: 'email',
      companyId: membership.company.id,
      companyName: membership.company.name,
      companyRole: membership.role,
    };
    session.accessToken = authResponse.accessToken;
    session.refreshToken = authResponse.refreshToken;
    await session.save();

    // BAL-362: a returning user whose workosId was re-linked onto their live
    // verified-email row (post-commit — the re-link tx already committed). Mutually
    // exclusive with isNewUser below, so the welcome email / domain-join are skipped.
    if (didRelink) {
      trackServerAndFlush(AUTH_SERVER_EVENTS.AUTH_RELINK, {
        distinct_id: user.id,
        method: 'otp',
      });
    }

    if (isNewUser) {
      // role is always 'client' — experts sign up as clients first,
      // then apply separately (see expert.application_submitted event).
      // The 'expert' variant of WelcomeEmail is reserved for a future
      // expert-specific signup flow.
      publishNotificationEvent('user.welcome', {
        correlationId: user.id,
        userId: user.id,
        role: 'client',
      }).catch(() => {
        // publishNotificationEvent logs internally
      });

      // BAL-344: emit the domain auto-capture outcome (post-commit). Email
      // verification is the primary capture path — the domain is now verified.
      emitDomainCapture(domainCapture, user.id);

      // BAL-345: run the domain auto-join match engine (post-commit). `true` is
      // legitimately hardcoded here — the OTP flow PROVES the email is verified.
      // runDomainJoinAndEmit swallows its own failures; the `.catch` is
      // belt-and-suspenders so a domain-join failure can NEVER break auth.
      await runDomainJoinAndEmit({ userId: user.id, email: user.email, emailVerified: true }).catch(
        () => {
          // runDomainJoinAndEmit already logs internally.
        }
      );
    }

    // BAL-362: also reached on the re-link / double-submit path (no user created),
    // so the message states only what always holds — verification completed.
    log.info('Email verification completed', {
      userId: user.id,
      email: user.email,
      isNewUser,
    });

    return {
      success: true,
      data: {
        needsOnboarding: true,
        userId: user.id,
        email: user.email,
        activeMode: user.activeMode,
        platformRole: 'user',
      },
    };
  } catch (error) {
    // BAL-362: a live Balo user owns this email under a different identity and its
    // existing row is unverified — refuse the re-link, surface a clean conflict (the
    // incoming OTP identity is always verified, so this is the only conflict here).
    // `distinct_id` is the internal user id only (never the email/PII).
    if (error instanceof AccountExistsError) {
      trackServerAndFlush(AUTH_SERVER_EVENTS.AUTH_CONFLICT, {
        distinct_id: error.existingUserId,
        method: 'otp',
      });
      log.warn('Email verification: email owned by a different identity — conflict', {
        existingUserId: error.existingUserId,
      });
      return { success: false, error: ACCOUNT_EXISTS_MESSAGE, code: 'account_exists' };
    }
    log.error('Email verification failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: mapWorkOSError(error) };
  }
}
