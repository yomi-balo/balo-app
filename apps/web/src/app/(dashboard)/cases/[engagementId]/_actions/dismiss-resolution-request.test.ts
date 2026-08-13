import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * BAL-421 — unit tests for the CLIENT dismissing the expert's resolution request.
 *
 * ⚠⚠ `authorizeCaseMutation` IS MOCKED HERE, ON PURPOSE. Its own suite
 * (`_lib/authorize-case-mutation.test.ts`) already proves the preamble in full — the onboarded
 * session, the strict schema, the re-run tenancy gate, the case-type coherence check and,
 * centrally, the anti-oracle property. Re-proving any of that through this action would be
 * duplication that fails in two places for one cause. What is genuinely THIS module's is the
 * COMPOSITION on top of the gate:
 *
 *   · the gate's refusal is returned VERBATIM (it is the one place the copy is decided);
 *   · the EXPERT LENS is refused BEFORE any capability is resolved — the expert ASKS on the
 *     engagement axis, the client ANSWERS on the membership axis. Two questions, two holder
 *     sets, and folding them together would make one of them wrong;
 *   · the capability is `PARTICIPATE` on the MEMBERSHIP axis, scoped with the GATE's
 *     `companyId` (ADR-1029) — never the session's, never input's;
 *   · dismissal is SILENT (owner decision D-E): no notification, no domain event;
 *   · the PostHog event carries NO `meeting_id` — the case surface has no meeting in scope.
 */

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-00000000d001';
const USER_ID = 'u0000000-0000-4000-8000-00000000d002';
const GATE_COMPANY_ID = 'c0000000-0000-4000-8000-00000000d003';
const PROFILE_ID = 'p0000000-0000-4000-8000-00000000d004';
/** A company the caller might wish they were acting in. The gate's answer must win. */
const OTHER_COMPANY_ID = 'c0000000-0000-4000-8000-00000000d0ff';

vi.mock('server-only', () => ({}));

const mockClearResolutionRequest = vi.fn();
vi.mock('@balo/db', () => ({
  caseEngagementsRepository: {
    clearResolutionRequest: (...a: unknown[]) => mockClearResolutionRequest(...a),
  },
}));

const mockAuthorize = vi.fn();
vi.mock('../_lib/authorize-case-mutation', () => ({
  authorizeCaseMutation: (...a: unknown[]) => mockAuthorize(...a),
}));

const mockHasCapability = vi.fn();
// ⚠ `CAPABILITIES` comes from SOURCE, so a rename of the token fails HERE rather than leaving
// a green suite asserting a dead string.
vi.mock('@/lib/authz', async () => {
  const authz = await import('@balo/shared/authz');
  return {
    hasCapability: (...a: unknown[]) => mockHasCapability(...a),
    CAPABILITIES: authz.CAPABILITIES,
  };
});

const mockRevalidate = vi.fn();
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => mockRevalidate(...a) }));

const mockTrack = vi.fn();
vi.mock('@/lib/analytics/server', async () => {
  const events = await import('@balo/analytics/events');
  return {
    trackServerAndFlush: (...a: unknown[]) => mockTrack(...a),
    RECAP_SERVER_EVENTS: events.RECAP_SERVER_EVENTS,
  };
});

/**
 * ⚠ MOCKED PURELY SO ITS SILENCE IS OBSERVABLE. Dismissal must publish NOTHING (D-E). The
 * factory below never even runs while that holds; the day someone wires a publish in, this
 * mock intercepts it and the assertion below fails.
 */
const mockPublish = vi.fn();
vi.mock('@/lib/notifications/publish', () => ({
  publishNotificationEvent: (...a: unknown[]) => {
    mockPublish(...a);
    return Promise.resolve();
  },
}));

import { dismissResolutionRequestAction } from './dismiss-resolution-request';
import { CAPABILITIES } from '@balo/shared/authz';
import { RECAP_SERVER_EVENTS } from '@balo/analytics/events';
import { log } from '@/lib/logging';

const INPUT = { engagementId: ENGAGEMENT_ID };

const DENIED = "You don't have permission to do that.";

function gateOk(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    user: { id: USER_ID },
    engagementId: ENGAGEMENT_ID,
    companyId: GATE_COMPANY_ID,
    expertProfileId: PROFILE_ID,
    lens: 'client',
    // Threaded through by the gate; this action reads none of it, and must not start.
    caseRow: { engagementId: ENGAGEMENT_ID, title: 'CPQ discount matrix', closedAt: null },
    ...over,
  };
}

function trackedPayload(): Record<string, unknown> {
  const [call] = mockTrack.mock.calls;
  if (call === undefined) {
    throw new Error('expected the dismissal to have been tracked');
  }
  const [, payload] = call as [string, Record<string, unknown>];
  return payload;
}

function seed(): void {
  vi.clearAllMocks();
  mockAuthorize.mockResolvedValue(gateOk());
  mockHasCapability.mockResolvedValue(true);
  mockClearResolutionRequest.mockResolvedValue({ engagementId: ENGAGEMENT_ID });
}

beforeEach(() => {
  seed();
});

describe('dismissResolutionRequestAction — it defers to the shared gate', () => {
  it('hands the raw input to the gate, unmodified', async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(mockAuthorize).toHaveBeenCalledWith(INPUT);
  });

  it('returns the gate refusal VERBATIM and runs nothing else', async () => {
    mockAuthorize.mockResolvedValue({ ok: false, error: 'This case is no longer available.' });
    expect(await dismissResolutionRequestAction(INPUT)).toEqual({
      success: false,
      error: 'This case is no longer available.',
    });
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockClearResolutionRequest).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });

  it('does not rewrite a DIFFERENT gate refusal into its own copy', async () => {
    // Proves the pass-through is real rather than a coincidence of one shared literal —
    // "Invalid request." and "You are not signed in." must survive to the island's toast.
    mockAuthorize.mockResolvedValue({ ok: false, error: 'Invalid request.' });
    expect(await dismissResolutionRequestAction(INPUT)).toEqual({
      success: false,
      error: 'Invalid request.',
    });
  });
});

describe('dismissResolutionRequestAction — the client answers; the expert only asks', () => {
  /**
   * ⚠⚠ THE ORDER IS THE ASSERTION. Refusing the expert lens BEFORE resolving a capability
   * keeps the rule legible instead of emergent — an expert holds `MANAGE_ENGAGEMENT` on the
   * engagement axis, and if this ran a membership check first, "the expert is not a company
   * member" would be doing the work, which is true today and an accident tomorrow.
   */
  it('REFUSES the EXPERT lens before any capability is resolved', async () => {
    mockAuthorize.mockResolvedValue(gateOk({ lens: 'expert' }));

    expect(await dismissResolutionRequestAction(INPUT)).toEqual({ success: false, error: DENIED });
    expect(mockHasCapability).not.toHaveBeenCalled();
    expect(mockClearResolutionRequest).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('resolves PARTICIPATE on the MEMBERSHIP axis with the GATE companyId (ADR-1029)', async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(mockHasCapability).toHaveBeenCalledWith({ id: USER_ID }, CAPABILITIES.PARTICIPATE, {
      companyId: GATE_COMPANY_ID,
    });
  });

  it('scopes to whatever company the GATE reports — never a cached or default one', async () => {
    mockAuthorize.mockResolvedValue(gateOk({ companyId: OTHER_COMPANY_ID }));
    await dismissResolutionRequestAction(INPUT);
    expect(mockHasCapability).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      companyId: OTHER_COMPANY_ID,
    });
  });

  it('refuses a false capability with the SAME literal as the lens refusal', async () => {
    mockHasCapability.mockResolvedValue(false);
    expect(await dismissResolutionRequestAction(INPUT)).toEqual({ success: false, error: DENIED });
    expect(mockClearResolutionRequest).not.toHaveBeenCalled();
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

describe('dismissResolutionRequestAction — the clear, and what follows it', () => {
  it('clears the request by engagement id and succeeds', async () => {
    expect(await dismissResolutionRequestAction(INPUT)).toEqual({ success: true });
    expect(mockClearResolutionRequest).toHaveBeenCalledWith({ engagementId: ENGAGEMENT_ID });
  });

  it('reports a case that is no longer open when the clear matched no row', async () => {
    mockClearResolutionRequest.mockResolvedValue(undefined);
    expect(await dismissResolutionRequestAction(INPUT)).toEqual({
      success: false,
      error: 'This case is no longer open.',
    });
    // Nothing to measure and nothing changed — so neither fires.
    expect(mockTrack).not.toHaveBeenCalled();
    expect(mockRevalidate).not.toHaveBeenCalled();
  });

  it('revalidates the CASE path so the banner disappears on the next render', async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(mockRevalidate).toHaveBeenCalledWith('/cases/' + ENGAGEMENT_ID);
  });

  it('logs the dismissal as a business event', async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(log.info).toHaveBeenCalledWith('Case resolution request dismissed', {
      engagementId: ENGAGEMENT_ID,
      userId: USER_ID,
    });
  });

  it('maps an unexpected failure to friendly copy and logs the cause', async () => {
    mockClearResolutionRequest.mockRejectedValue(new Error('connection refused'));
    expect(await dismissResolutionRequestAction(INPUT)).toEqual({
      success: false,
      error: 'Something went wrong. Please try again.',
    });
    expect(log.error).toHaveBeenCalledWith(
      'Failed to dismiss case resolution request',
      expect.objectContaining({
        engagementId: ENGAGEMENT_ID,
        userId: USER_ID,
        error: 'connection refused',
      })
    );
  });
});

describe('dismissResolutionRequestAction — measurement only, and honestly attributed', () => {
  it('tracks the dismissal under the shared server event name', async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(mockTrack).toHaveBeenCalledWith(RECAP_SERVER_EVENTS.CASE_RESOLUTION_REQUEST_DISMISSED, {
      engagement_id: ENGAGEMENT_ID,
      distinct_id: USER_ID,
    });
  });

  /**
   * ⚠⚠ NO `meeting_id`, AND THE ABSENCE IS THE POINT. The field is OPTIONAL for exactly this
   * caller because the case surface has no meeting in scope. Sending "the most recent
   * consultation" to keep it populated would attribute the dismissal to a call that had
   * nothing to do with it — worse for analysis than an honest null.
   */
  it('sends NO meeting_id — the case surface has none in scope', async () => {
    await dismissResolutionRequestAction(INPUT);
    const payload = trackedPayload();
    expect(Object.keys(payload).sort()).toEqual(['distinct_id', 'engagement_id']);
    expect(payload).not.toHaveProperty('meeting_id');
  });

  /**
   * ⚠⚠ OWNER DECISION D-E: DISMISSAL IS SILENT. Clearing the request leaves the case open and
   * the expert is NOT told — there is no notification, no domain event, no template and no
   * rule. The PostHog event above is measurement, not a message.
   */
  it('publishes NO domain event and sends NO notification', async () => {
    await dismissResolutionRequestAction(INPUT);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
