'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { usersRepository, auditEventsRepository, db } from '@balo/db';
import { platformRoleIsStaff } from '@balo/shared/authz';
import { requireOnboardedUser, getSession } from '@/lib/auth/session';
import { hasPlatformCapability, PLATFORM_CAPABILITIES } from '@/lib/authz/platform';
import { isImpersonatedSession, markSessionAsImpersonated } from '@/lib/auth/impersonation';
import { buildImpersonatedSessionUser } from '@/lib/auth/impersonation-target';
import {
  sealPreservedAdminSession,
  unsealPreservedAdminSession,
  writePreservedAdminCookie,
  readPreservedAdminCookie,
  clearPreservedAdminCookie,
} from '@/lib/auth/impersonation-preserved-session';
import {
  sessionConfig,
  impersonatedSessionConfig,
  IMPERSONATED_SESSION_MAX_AGE_SECONDS,
} from '@/lib/auth/session-config';
import { log } from '@/lib/logging';

/**
 * BAL-553 — the impersonation entry point. `startImpersonationAction` / `stopImpersonationAction`
 * are POLICY ONLY: gate → validate → build → mark → seal. The mechanics they call — the flag
 * writer (`./lib/auth/impersonation.ts`), the sealed preserved-admin-session primitive
 * (`./impersonation-preserved-session.ts`), and the target session builder
 * (`./impersonation-target.ts`) — each own exactly one concern, so a security reviewer can read
 * this file top to bottom.
 *
 * ⚠⚠ ACCEPTED, DOCUMENTED DEGRADATION (orchestrator ruling on Open Question 3) — the impersonated
 * session carries NO WorkOS `accessToken`/`refreshToken` (⟦R1⟧ this ticket's session swap is
 * Balo-LOCAL; WorkOS is never called). Every `apps/api`-backed surface a session drives — MEETING
 * JOIN, PHONE VERIFICATION, and the CREDIT API (SetupIntent capture, purchase, top-up) — therefore
 * returns its existing "unauthenticated" arm for the duration of an impersonated session. This is
 * DELIBERATE, not a bug to fix here: the alternative (carrying the admin's tokens, as the
 * `workos-auth` skill's sketch does) is a confused-deputy hole — `apps/api` would authenticate the
 * bearer as the ADMIN while the web session presents as the TARGET, which is precisely the credit
 * SPEND-side hazard this ticket scopes out. Failing closed is right. If support ever needs those
 * surfaces to work under impersonation, that is a SEPARATE ticket that must first decide what
 * identity `apps/api` should see.
 *
 * ⚠ NO UI SHIPS WITH THIS TICKET ⟦R8⟧. These are server-only entry points with no caller yet —
 * intentionally NOT re-exported from `./index.ts` (that barrel is reachable from client auth
 * modals, and its module value-imports `@balo/db`).
 */

const startImpersonationSchema = z
  .object({
    targetUserId: z.uuid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

const NOT_SIGNED_IN = 'You are not signed in.';
const PERMISSION_DENIED = 'You do not have permission to do this.';
const GENERIC_FAILURE = 'Something went wrong. Please try again.';

export type StartImpersonationResult =
  | { success: true; targetUserId: string; expiresAt: number }
  | {
      success: false;
      error: string;
      code:
        | 'not_signed_in'
        | 'denied'
        | 'invalid'
        | 'target_unavailable'
        | 'target_is_staff'
        | 'already_impersonating'
        | 'failed';
    };

export type StopImpersonationResult =
  | { success: true }
  | {
      success: false;
      error: string;
      code: 'not_signed_in' | 'not_impersonating' | 'restore_unavailable' | 'failed';
    };

/**
 * Start a Balo-local impersonated session (⟦R1⟧). See the module docblock above for the
 * accepted `apps/api` degradation; see the `platformRoleIsStaff` check below for the threat
 * model behind refusing a staff target.
 *
 * Ordered so that every cheap refusal precedes every expensive one, and so that nothing is
 * written before every check has passed.
 */
export async function startImpersonationAction(input: {
  targetUserId: string;
  reason: string;
}): Promise<StartImpersonationResult> {
  let actor;
  try {
    actor = await requireOnboardedUser();
  } catch {
    return { success: false, error: NOT_SIGNED_IN, code: 'not_signed_in' };
  }

  // BAL-553 fix round 1, S1/F6 — VALIDATED FIRST, before anything else touches `input`. Moved
  // ahead of every check below on purpose: `input` is caller-controlled wire data (the function
  // signature's TypeScript type is not a runtime guarantee across the Server Action boundary),
  // so logging or dereferencing `input.targetUserId` before this point would (a) let any
  // signed-in onboarded non-staff caller force an arbitrarily large raw string into a log line
  // repeatedly (log amplification / cost), and (b) throw an unhandled TypeError OUTSIDE the
  // try/catch below for a `null`/malformed payload instead of returning a clean refusal.
  // `safeParse` never throws — a `null` input resolves to `parsed.success === false` here, not a
  // crash.
  const parsed = startImpersonationSchema.safeParse(input);
  if (!parsed.success) {
    log.warn('Impersonation start refused', { actorUserId: actor.id, code: 'invalid' });
    return { success: false, error: 'Invalid request.', code: 'invalid' };
  }
  const { targetUserId, reason } = parsed.data;

  // Belt and braces: step 5 below already re-derives the capability from a fresh DB read, and
  // step 6 blocks staff targets — but session CHAINING (impersonating from inside an
  // impersonated session) is refused unconditionally, with no nesting, ever.
  if (isImpersonatedSession(actor)) {
    log.warn('Impersonation start refused', {
      actorUserId: actor.id,
      code: 'already_impersonating',
      targetUserId,
    });
    return { success: false, error: PERMISSION_DENIED, code: 'already_impersonating' };
  }

  // Fast path on the SEALED role — no DB round trip is paid to say no to an obviously
  // unprivileged actor. Reads the now-VALIDATED `targetUserId`, never the raw `input`.
  if (!hasPlatformCapability(actor, PLATFORM_CAPABILITIES.IMPERSONATE_USER)) {
    log.warn('Impersonation start refused', {
      actorUserId: actor.id,
      code: 'denied',
      targetUserId,
    });
    return { success: false, error: PERMISSION_DENIED, code: 'denied' };
  }

  if (targetUserId === actor.id) {
    log.warn('Impersonation start refused', {
      actorUserId: actor.id,
      code: 'invalid',
      targetUserId,
    });
    return { success: false, error: 'Invalid request.', code: 'invalid' };
  }

  try {
    // ⚠ NOT REDUNDANT WITH THE SEALED-ROLE CHECK ABOVE. The cookie is authoritative about what
    // was sealed but can be up to seven days stale: a demoted, suspended or deleted staff member
    // would otherwise keep the most powerful capability in the product until their cookie
    // expired. One extra query, on the rarest path in the app.
    const actorRow = await usersRepository.findForSessionSync(actor.id);
    if (
      actorRow === null ||
      actorRow.deletedAt !== null ||
      actorRow.status !== 'active' ||
      !hasPlatformCapability(
        { platformRole: actorRow.platformRole },
        PLATFORM_CAPABILITIES.IMPERSONATE_USER
      )
    ) {
      log.warn('Impersonation start refused', {
        actorUserId: actor.id,
        code: 'denied',
        targetUserId,
      });
      return { success: false, error: PERMISSION_DENIED, code: 'denied' };
    }

    const targetRow = await usersRepository.findForSessionSync(targetUserId);
    if (targetRow === null || targetRow.deletedAt !== null || targetRow.status !== 'active') {
      log.warn('Impersonation start refused', {
        actorUserId: actor.id,
        code: 'target_unavailable',
        targetUserId,
      });
      return { success: false, error: PERMISSION_DENIED, code: 'target_unavailable' };
    }

    // Cannot impersonate another staff member — three independent reasons, each load-bearing
    // on its own (fix round 2, F5 — inlined here; this used to point at a gitignored plan file
    // no reader could open):
    //   1. CAPABILITY INHERITANCE. The sealed session carries the TARGET's real `platformRole`
    //      (⟦R7b⟧ self-consistency). Impersonating another `super_admin` would therefore mint a
    //      session that itself holds `IMPERSONATE_USER` — a chain of impersonations, each with
    //      its own preserved cookie, with no way to reason about who is really acting.
    //   2. ATTRIBUTION LAUNDERING. Staff actions are audited by `actorUserId`. Acting as another
    //      staff member would let one `super_admin` produce audit rows naming a colleague —
    //      exactly the confusion `impersonatorUserId` exists to prevent.
    //   3. NO SUPPORT USE CASE. Impersonation exists to see what a CUSTOMER sees; there is no
    //      legitimate reason to operate the product as a fellow staff member.
    if (platformRoleIsStaff(targetRow.platformRole)) {
      log.warn('Impersonation start refused', {
        actorUserId: actor.id,
        code: 'target_is_staff',
        targetUserId,
      });
      return { success: false, error: PERMISSION_DENIED, code: 'target_is_staff' };
    }

    // BAL-553 fix round 2, F4 — pass the SAME `targetRow` just checked above, rather than
    // letting `buildImpersonatedSessionUser` re-query and seal a possibly-different row.
    const target = await buildImpersonatedSessionUser(targetUserId, targetRow);
    if (target === null) {
      log.warn('Impersonation start refused', {
        actorUserId: actor.id,
        code: 'target_unavailable',
        targetUserId,
      });
      return { success: false, error: PERMISSION_DENIED, code: 'target_unavailable' };
    }

    const expiresAt = Date.now() + IMPERSONATED_SESSION_MAX_AGE_SECONDS * 1000;

    // Audited BEFORE the swap: if the save below then fails, we hold an audit row for an
    // impersonation that did not happen — strictly better than an impersonation that happened
    // with no audit row.
    await auditEventsRepository.record(
      {
        actorUserId: actor.id,
        action: 'impersonation.started',
        entityType: 'user',
        entityId: targetUserId,
        metadata: { reason, expiresAt },
      },
      db
    );
    log.info('Impersonation started', { actorUserId: actor.id, targetUserId, expiresAt });

    const session = await getSession();
    const preservedSeal = await sealPreservedAdminSession({
      user: session.user,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
    });
    await writePreservedAdminCookie(preservedSeal);

    // DOCUMENT-ONLY (fix round 1, security agent informational) — ORDERING HAZARD, not a
    // mechanism to build: if `session.save()` below throws (caught by the try/catch around this
    // whole block), the preserved-admin cookie written just above is already on the browser, but
    // the swap to the impersonated session never happened — so a later `stopImpersonationAction()`
    // call sees a NORMAL (non-impersonated) session and returns `not_impersonating` without ever
    // clearing `balo_admin_session`. It is the admin's OWN sealed session, so there is no
    // escalation; it simply sits, orphaned, until its own 30-minute TTL expires it. Not fixed
    // here — see the audit-then-swap ordering above for the analogous, deliberate trade-off.
    session.user = markSessionAsImpersonated(target, { impersonatorUserId: actor.id, expiresAt });
    delete session.accessToken;
    delete session.refreshToken;
    session.updateConfig(impersonatedSessionConfig(IMPERSONATED_SESSION_MAX_AGE_SECONDS));
    await session.save();

    // The identity behind this browser just changed — cached RSC output for the previous one
    // must not be served.
    revalidatePath('/', 'layout');

    return { success: true, targetUserId, expiresAt };
  } catch (error) {
    log.error('Impersonation start failed', {
      actorUserId: actor.id,
      targetUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE, code: 'failed' };
  }
}

/**
 * Stop an impersonated session and restore the staff member's own. Uses `getSession()`, NOT
 * `requireOnboardedUser()` — impersonating a stuck, un-onboarded user is a prime support case,
 * and `requireOnboardedUser` would trap the staff member inside that session with no way out.
 *
 * ⚠⚠ THERE IS DELIBERATELY NO CAPABILITY CHECK HERE, AND ADDING ONE WOULD BE A LOCKOUT. The
 * impersonated session carries the TARGET's `platformRole` (ordinarily `user`) and therefore
 * holds no platform capability at all. Authority to stop comes from POSSESSION OF THE SEALED
 * PRESERVED-ADMIN COOKIE, which only this server can mint — not from a capability.
 *
 * DOCUMENT-ONLY (fix round 1, security agent informational) — a DECISION, not an oversight: this
 * restore does NOT re-verify the admin's CURRENT DB status (demoted / suspended / deleted since
 * the preserved cookie was sealed, up to 30 minutes ago). It is not a new hole — a normal 7-day
 * session has the identical staleness window between sign-ins — and the very next authenticated
 * request self-heals through `checkSessionDrift` / the session-sync route, exactly like any other
 * session. Re-verifying here would duplicate that mechanism for a window strictly shorter than
 * the one every other session already tolerates.
 */
export async function stopImpersonationAction(): Promise<StopImpersonationResult> {
  const session = await getSession();
  const user = session.user;
  if (user === undefined) {
    return { success: false, error: NOT_SIGNED_IN, code: 'not_signed_in' };
  }

  if (!isImpersonatedSession(user)) {
    return { success: false, error: PERMISSION_DENIED, code: 'not_impersonating' };
  }

  const targetUserId = user.id;
  const impersonatorUserId = user.impersonatorUserId;

  try {
    const seal = await readPreservedAdminCookie();
    const preserved = seal === undefined ? null : await unsealPreservedAdminSession(seal);

    // ⚠ FAIL CLOSED. A missing, expired, forged or MISMATCHED preserved session must never leave
    // the browser holding the impersonated session — destroy it and require a fresh sign-in.
    const bound = preserved !== null && preserved.user?.id === impersonatorUserId;
    if (!bound) {
      session.destroy();
      await clearPreservedAdminCookie();
      log.warn('Impersonation stop could not restore the staff session', {
        targetUserId,
        impersonatorUserId,
      });
      await auditEventsRepository.record(
        {
          actorUserId: impersonatorUserId ?? null,
          action: 'impersonation.stopped',
          entityType: 'user',
          entityId: targetUserId,
          metadata: { outcome: 'restore_unavailable' },
        },
        db
      );
      return { success: false, error: GENERIC_FAILURE, code: 'restore_unavailable' };
    }

    session.user = preserved.user;
    session.accessToken = preserved.accessToken;
    session.refreshToken = preserved.refreshToken;
    // ⚠ REQUIRED — undo getSession()'s 30-minute pre-arm; without this the admin's restored
    // session would save with the still-armed impersonated-session config.
    session.updateConfig(sessionConfig);
    await session.save();

    await clearPreservedAdminCookie();
    await auditEventsRepository.record(
      {
        actorUserId: impersonatorUserId ?? null,
        action: 'impersonation.stopped',
        entityType: 'user',
        entityId: targetUserId,
        metadata: { outcome: 'restored' },
      },
      db
    );
    log.info('Impersonation stopped', { actorUserId: impersonatorUserId, targetUserId });

    revalidatePath('/', 'layout');

    return { success: true };
  } catch (error) {
    log.error('Impersonation stop failed', {
      targetUserId,
      impersonatorUserId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: GENERIC_FAILURE, code: 'failed' };
  }
}
