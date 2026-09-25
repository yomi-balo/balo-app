import { describe, expect, it } from 'vitest';
import {
  buildCaseClosedPayload,
  capCaseTitle,
  CASE_TITLE_MAX,
  summariseCaseCloseAnchors,
  type BuildCaseClosedPayloadInput,
  type CaseCloseAnchorMeeting,
} from './case-closed';

/**
 * BAL-572 — parity tests for the case-close payload assembly PORTED from
 * `apps/web/src/lib/cases/close-case-effects.ts`. Every fixture and expectation below mirrors
 * `close-case-effects.test.ts`'s `publishCaseClosed` / `readCloseAnchors` suites; this file is
 * the proof the port kept the same fallbacks, ordering and tie-break rules, one layer down from
 * the web module's own reads.
 */

// ── capCaseTitle ─────────────────────────────────────────────────────────────────────────

describe('capCaseTitle — both sides of the cap, idempotent', () => {
  it('passes an under-cap title through byte for byte', () => {
    expect(capCaseTitle('Flow interview loop')).toBe('Flow interview loop');
  });

  it('passes a title of EXACTLY the cap through unchanged', () => {
    const exact = 'x'.repeat(CASE_TITLE_MAX);
    expect(capCaseTitle(exact)).toBe(exact);
    expect(capCaseTitle(exact)).toHaveLength(CASE_TITLE_MAX);
  });

  it('truncates one character over the cap, with an ellipsis in the last position', () => {
    const capped = capCaseTitle('y'.repeat(CASE_TITLE_MAX + 1));
    expect(capped).toHaveLength(CASE_TITLE_MAX);
    expect(capped.endsWith('…')).toBe(true);
    expect(capped.startsWith('yyy')).toBe(true);
  });

  it('is idempotent — capping an already-capped title changes nothing further', () => {
    const capped = capCaseTitle('z'.repeat(CASE_TITLE_MAX + 50));
    expect(capCaseTitle(capped)).toBe(capped);
  });
});

// ── summariseCaseCloseAnchors ────────────────────────────────────────────────────────────

function sibling(id: string, over: Partial<CaseCloseAnchorMeeting> = {}): CaseCloseAnchorMeeting {
  return {
    id,
    scheduledStart: new Date('2026-07-01T10:00:00Z'),
    startedAt: new Date('2026-07-01T10:00:00Z'),
    status: 'ended',
    outcome: 'completed',
    ...over,
  };
}

describe('summariseCaseCloseAnchors — heldCount + the CTA anchor, over a structural sibling type', () => {
  it('counts and anchors on the single most recent held meeting', () => {
    expect(summariseCaseCloseAnchors([sibling('m1'), sibling('m2')])).toEqual({
      heldCount: 2,
      anchorMeetingId: 'm2',
    });
  });

  it('anchors to the MOST RECENT held consultation, not the last array entry', () => {
    const result = summariseCaseCloseAnchors([
      sibling('m-new', { startedAt: new Date('2026-07-08T10:00:00Z') }),
      sibling('m-old', { startedAt: new Date('2026-07-01T10:00:00Z') }),
    ]);
    expect(result.anchorMeetingId).toBe('m-new');
  });

  it('falls back to scheduledStart for a held meeting with no startedAt stamp', () => {
    const result = summariseCaseCloseAnchors([
      sibling('m-scheduled-late', {
        startedAt: null,
        scheduledStart: new Date('2026-07-20T10:00:00Z'),
      }),
      sibling('m-started-early', { startedAt: new Date('2026-07-05T10:00:00Z') }),
    ]);
    expect(result.anchorMeetingId).toBe('m-scheduled-late');
  });

  it('breaks an exact timestamp tie on id, so the CTA is stable across refreshes', () => {
    const sameInstant = new Date('2026-07-09T10:00:00Z');
    const result = summariseCaseCloseAnchors([
      sibling('aaa', { startedAt: sameInstant }),
      sibling('zzz', { startedAt: sameInstant }),
    ]);
    expect(result.anchorMeetingId).toBe('zzz');
  });

  it('counts and anchors ONLY on ended+completed — never a cancelled or no-show slot', () => {
    const result = summariseCaseCloseAnchors([
      sibling('m-held', { startedAt: new Date('2026-07-01T10:00:00Z') }),
      sibling('m-noshow', {
        startedAt: new Date('2026-07-05T10:00:00Z'),
        outcome: 'no_show_client',
      }),
      sibling('m-inprogress', {
        startedAt: new Date('2026-07-06T10:00:00Z'),
        status: 'in_progress',
      }),
      sibling('m-cancelled', { startedAt: new Date('2026-07-07T10:00:00Z'), status: 'cancelled' }),
    ]);
    expect(result).toEqual({ heldCount: 1, anchorMeetingId: 'm-held' });
  });

  it('returns heldCount 0 and no anchor for an empty sibling set', () => {
    expect(summariseCaseCloseAnchors([])).toEqual({ heldCount: 0, anchorMeetingId: undefined });
  });

  it('accepts a structural row wider than its own type — a full Meeting row is assignable', () => {
    const wideRow = {
      id: 'm1',
      scheduledStart: new Date('2026-07-01T10:00:00Z'),
      startedAt: new Date('2026-07-01T10:00:00Z'),
      status: 'ended' as const,
      outcome: 'completed',
      dailyRoomName: 'case-room-7f3a',
      joinUrl: 'https://balo.daily.co/room?t=SECRETJOINTOKEN',
    };
    expect(summariseCaseCloseAnchors([wideRow])).toEqual({ heldCount: 1, anchorMeetingId: 'm1' });
  });
});

// ── buildCaseClosedPayload ───────────────────────────────────────────────────────────────

const ENGAGEMENT_ID = 'e0000000-0000-4000-8000-000000000001';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000003';
const CLOSED_AT = new Date('2026-08-12T09:00:00Z');

function payloadInput(
  over: Partial<BuildCaseClosedPayloadInput> = {}
): BuildCaseClosedPayloadInput {
  return {
    engagementId: ENGAGEMENT_ID,
    meetingId: 'm0000000-0000-4000-8000-00000000000a',
    recipientId: 'u0000000-0000-4000-8000-000000000002',
    expertProfileId: PROFILE_ID,
    companyName: 'Northwind Industrial',
    expertProfileType: 'freelancer',
    agencyName: null,
    expertFirstName: 'Amara',
    expertLastName: 'Okafor',
    caseTitle: 'Flow interview loop',
    closedAt: CLOSED_AT,
    closeReason: 'resolved',
    consultationCount: 2,
    reviewToken: 'raw-token',
    ...over,
  };
}

describe('buildCaseClosedPayload — the correlation id, one fallback per optional read', () => {
  it('assembles the full payload from resolved reads', () => {
    expect(buildCaseClosedPayload(payloadInput())).toEqual({
      correlationId: ENGAGEMENT_ID + ':case_closed',
      engagementId: ENGAGEMENT_ID,
      meetingId: 'm0000000-0000-4000-8000-00000000000a',
      recipientId: 'u0000000-0000-4000-8000-000000000002',
      expertProfileId: PROFILE_ID,
      clientCompanyName: 'Northwind Industrial',
      expertPartyLabel: 'Amara Okafor',
      caseTitle: 'Flow interview loop',
      closedDate: '12 Aug 2026',
      closeReason: 'resolved',
      consultationCount: 2,
      reviewToken: 'raw-token',
    });
  });

  it('the correlation id is deterministic and engagement-scoped, never randomised', () => {
    const payload = buildCaseClosedPayload(payloadInput());
    expect(payload.correlationId).toBe(`${ENGAGEMENT_ID}:case_closed`);
  });

  it('threads the caller-supplied closeReason verbatim — auto_inactive included', () => {
    const payload = buildCaseClosedPayload(payloadInput({ closeReason: 'auto_inactive' }));
    expect(payload.closeReason).toBe('auto_inactive');
  });

  it('falls back to "your company" when companyName is absent', () => {
    const payload = buildCaseClosedPayload(payloadInput({ companyName: undefined }));
    expect(payload.clientCompanyName).toBe('your company');
  });

  it('falls back to "An expert" when the profile type is absent and no name resolves', () => {
    const payload = buildCaseClosedPayload(
      payloadInput({
        expertProfileType: undefined,
        expertFirstName: null,
        expertLastName: null,
      })
    );
    expect(payload.expertPartyLabel).toBe('An expert');
  });

  it('defaults an absent profile type to freelancer, naming the person', () => {
    const payload = buildCaseClosedPayload(payloadInput({ expertProfileType: undefined }));
    expect(payload.expertPartyLabel).toBe('Amara Okafor');
  });

  it('names the AGENCY for an agency-typed profile with a resolved agency name', () => {
    const payload = buildCaseClosedPayload(
      payloadInput({ expertProfileType: 'agency', agencyName: 'CloudPeak' })
    );
    expect(payload.expertPartyLabel).toBe('CloudPeak');
  });

  it('falls back to the PERSON when an agency-typed profile has no resolvable agency', () => {
    const payload = buildCaseClosedPayload(
      payloadInput({ expertProfileType: 'agency', agencyName: null })
    );
    expect(payload.expertPartyLabel).toBe('Amara Okafor');
  });

  it('renders a first-name-only person without an empty trailing space', () => {
    const payload = buildCaseClosedPayload(payloadInput({ expertLastName: null }));
    expect(payload.expertPartyLabel).toBe('Amara');
  });

  it('caps an over-limit case title before it reaches the payload', () => {
    const payload = buildCaseClosedPayload(
      payloadInput({ caseTitle: 'y'.repeat(CASE_TITLE_MAX + 1) })
    );
    expect(payload.caseTitle).toHaveLength(CASE_TITLE_MAX);
    expect(payload.caseTitle.endsWith('…')).toBe(true);
  });

  it('carries no meetingId when the case had no held consultation', () => {
    const payload = buildCaseClosedPayload(payloadInput({ meetingId: undefined }));
    expect(payload.meetingId).toBeUndefined();
  });

  it('carries no recipientId on an owner-miss — the expert arm is unaffected by this alone', () => {
    const payload = buildCaseClosedPayload(payloadInput({ recipientId: undefined }));
    expect(payload.recipientId).toBeUndefined();
    expect(payload.expertProfileId).toBe(PROFILE_ID);
  });

  it('carries no reviewToken when the mint degraded or was never attempted', () => {
    const payload = buildCaseClosedPayload(payloadInput({ reviewToken: undefined }));
    expect(payload.reviewToken).toBeUndefined();
  });

  it('carries an absent consultationCount through as undefined, not coerced to 0', () => {
    const payload = buildCaseClosedPayload(payloadInput({ consultationCount: undefined }));
    expect(payload.consultationCount).toBeUndefined();
  });
});
