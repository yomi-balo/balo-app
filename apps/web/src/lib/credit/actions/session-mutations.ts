'use server';

import 'server-only';

import { z } from 'zod';
import { MAX_SESSION_MINUTES } from '@balo/shared/pricing';
import type { DrawdownState } from '@balo/shared/credit';
import { callSessionApi } from '../api-client';
import type {
  ActionResult,
  ConnectSessionData,
  EndSessionData,
  OpenSessionActionResult,
  OpenSessionData,
} from './types';

/**
 * BAL-378 (ADR-1040 Lane 2) — the thin credit-session Server Actions.
 *
 * Each is a minimal WorkOS-authed hop to the Fastify api (§8) via
 * {@link callSessionApi}. They resolve the actor SERVER-SIDE (the api re-verifies the
 * Bearer token) and never accept an arbitrary WALLET id from the client. A `companyId`
 * (BAL-401) is accepted but is capability-gated server-side — `openSession` only honours a
 * company the caller holds CONSUME_CREDITS on (fail-closed), so it cannot be used to draw
 * down another tenant's wallet. The component layer toasts each outcome.
 */

const openInputSchema = z
  .object({
    expertProfileId: z.uuid(),
    estimatedMinutes: z.number().int().positive().max(MAX_SESSION_MINUTES),
    companyId: z.uuid().optional(),
  })
  .strict();

const sessionIdSchema = z.uuid();

/** Warm, non-leaking copy for each gate code — never the word "overdraft". */
const OPEN_GATE_MESSAGE: Record<string, string> = {
  insufficient_no_mandate: 'Top up to start this consultation.',
  account_hold: 'There is an unsettled balance to clear before starting a new consultation.',
  session_in_progress: 'A consultation is already in progress for this team — wrap it up first.',
  settlement_pending:
    "Just a moment — we're finalizing your last session. Try again in a few seconds.",
  expert_rate_missing: 'This expert has not set a rate yet — please try another expert.',
  forbidden: 'You do not have permission to start a consultation for this team.',
  company_selection_required: 'Choose which team this consultation is for.',
};

function openGateMessage(code: string | undefined): string {
  const fallback = 'Could not start the consultation.';
  if (code === undefined) {
    return fallback;
  }
  return OPEN_GATE_MESSAGE[code] ?? fallback;
}

/**
 * Open a PENDING credit session (gate + hold). The api resolves the wallet from the chosen
 * (capability-gated) company; a money / capability gate returns a warm, mapped message. When
 * more than one billing company is eligible and none was chosen, the failure carries the
 * eligible `companies` (BAL-401) for the caller to pick from.
 */
export async function openSessionAction(input: {
  expertProfileId: string;
  estimatedMinutes: number;
  companyId?: string;
}): Promise<OpenSessionActionResult> {
  const parsed = openInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Enter a valid expert and session length.' };
  }

  const result = await callSessionApi<OpenSessionData>('/sessions', 'POST', {
    expertProfileId: parsed.data.expertProfileId,
    estimatedMinutes: parsed.data.estimatedMinutes,
    ...(parsed.data.companyId === undefined ? {} : { companyId: parsed.data.companyId }),
  });

  if (!result.ok) {
    return {
      success: false,
      error: openGateMessage(result.code),
      code: result.code,
      ...(result.companies === undefined ? {} : { companies: result.companies }),
    };
  }
  return { success: true, data: result.data };
}

/** Connect a pending session (pending → active); returns the fresh drawdown state. */
export async function connectSessionAction(
  sessionId: string
): Promise<ActionResult<ConnectSessionData>> {
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    return { success: false, error: 'That consultation could not be found.' };
  }

  const result = await callSessionApi<DrawdownState>(
    `/sessions/${parsed.data}/connect`,
    'POST',
    {}
  );

  if (!result.ok) {
    return { success: false, error: 'Could not connect the consultation.', code: result.code };
  }
  return { success: true, data: result.data };
}

/** End a session: meter → release → accrual → settle. Returns the settlement summary. */
export async function endSessionAction(sessionId: string): Promise<ActionResult<EndSessionData>> {
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    return { success: false, error: 'That consultation could not be found.' };
  }

  const result = await callSessionApi<EndSessionData>(`/sessions/${parsed.data}/end`, 'POST', {});

  if (!result.ok) {
    return { success: false, error: 'Could not wrap up the consultation.', code: result.code };
  }
  return { success: true, data: result.data };
}

/** Member nudge — ask the team's billing admins to top up (publishes `session.topup_nudge`). */
export async function nudgeAdminAction(sessionId: string): Promise<ActionResult<{ ok: true }>> {
  const parsed = sessionIdSchema.safeParse(sessionId);
  if (!parsed.success) {
    return { success: false, error: 'That consultation could not be found.' };
  }

  const result = await callSessionApi<{ ok: true }>(`/sessions/${parsed.data}/nudge`, 'POST', {});

  if (!result.ok) {
    return {
      success: false,
      error: 'Could not send that nudge — please try again.',
      code: result.code,
    };
  }
  return { success: true, data: { ok: true } };
}
