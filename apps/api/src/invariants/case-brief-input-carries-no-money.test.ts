import { describe, expect, it, vi, beforeEach } from 'vitest';
import { markersInCode, readRaw } from './_source-scan.js';

/**
 * BAL-589 (D7 / D7a) — THE FEE-CONCEALMENT INVARIANT for the case→project brief path. A brief
 * drafted from a case reads the case's conversation and call history, and MUST NOT be able to
 * see, and therefore MUST NOT be able to leak into a project request, anything money-shaped:
 * a credit session, a rate, Balo's margin, a currency, or a billed duration.
 *
 * Three independent proofs, per the build contract:
 *  1. SCAN — neither `case-history.ts` nor `case-source.ts` names a forbidden money surface on
 *     any non-comment line.
 *  2. TWIN — the SAME scan, over a file that genuinely touches money
 *     (`services/credit-session/meter-driver.ts`), finds at least one needle. Without this, a
 *     scanner that silently matched nothing (a typo'd needle, a wrong path) would make proof 1
 *     pass for the wrong reason.
 *  3. SHAPE — `buildCaseHistoryInput`'s output key set is pinned exactly, even when the
 *     underlying (mocked) rows carry extra money-ish fields. This is the belt to the scan's
 *     braces: a future field added to `CaseHistoryMessage`/`CaseHistoryTranscript` under an
 *     innocent-looking name would not trip the scan, but WOULD widen this key set.
 *
 * Every assertion here has been mutation-proven individually: add a forbidden needle to
 * `case-history.ts`'s CODE (not a comment), watch proof 1 go red, revert; rename the twin file's
 * reference away from every needle, watch proof 2 go red, revert; add a field to
 * `CaseHistoryMessage`/`buildCaseHistoryInput`'s return, watch proof 3 go red, revert.
 */

const CASE_HISTORY_FILE = 'services/project-brief/case-history.ts';
const CASE_SOURCE_FILE = 'services/project-brief/case-source.ts';
/** A file that genuinely touches money — the twin / non-vacuity control for proof 1. */
const MONEY_TWIN_FILE = 'services/credit-session/meter-driver.ts';

const FORBIDDEN_MONEY_NEEDLES = [
  'credit',
  'Credit',
  'rateCents',
  'rate_cents',
  'baloFeeBps',
  'balo_fee_bps',
  'currency',
  'consultationTimestampsForEngagements',
  'Minutes',
  'Minor',
  'durationMs',
  'ledger',
  'Ledger',
];

describe('invariant: the case-brief input carries no money (BAL-589 D7)', () => {
  it('reads real, non-empty content for all three subject files (guards a vacuous pass)', () => {
    const historyRaw = readRaw(CASE_HISTORY_FILE);
    const sourceRaw = readRaw(CASE_SOURCE_FILE);
    const twinRaw = readRaw(MONEY_TWIN_FILE);
    expect(historyRaw).toContain('buildCaseHistoryInput');
    expect(sourceRaw).toContain('loadCaseSource');
    expect(twinRaw.length).toBeGreaterThan(0);
  });

  // ── Proof 1 — the scan ──────────────────────────────────────────────────────────────────────
  it('⚠ case-history.ts names no forbidden money surface on a non-comment line', () => {
    const offenders = markersInCode(readRaw(CASE_HISTORY_FILE), FORBIDDEN_MONEY_NEEDLES);
    expect(offenders, `case-history.ts references: ${offenders.join(', ')}`).toEqual([]);
  });

  it('⚠ case-source.ts names no forbidden money surface on a non-comment line', () => {
    const offenders = markersInCode(readRaw(CASE_SOURCE_FILE), FORBIDDEN_MONEY_NEEDLES);
    expect(offenders, `case-source.ts references: ${offenders.join(', ')}`).toEqual([]);
  });

  // ── Proof 2 — the twin (the scanner is not silently broken) ────────────────────────────────
  it('⚠⚠ the mutation proof: the SAME scan DOES find a money surface in the credit-session twin', () => {
    const offenders = markersInCode(readRaw(MONEY_TWIN_FILE), FORBIDDEN_MONEY_NEEDLES);
    expect(offenders.length).toBeGreaterThan(0);
    expect(offenders).toContain('credit');
  });
});

// ── Proof 3 — the shape check ──────────────────────────────────────────────────────────────────

const findByContext = vi.fn();
const listMessages = vi.fn();
const listMeetingsForContext = vi.fn();
const findByMeetingIds = vi.fn();
const findByTranscriptAndKind = vi.fn();
const findById = vi.fn();

vi.mock('@balo/db', () => ({
  conversationsRepository: {
    findByContext: (...args: unknown[]) => findByContext(...args),
    listMessages: (...args: unknown[]) => listMessages(...args),
  },
  meetingContextsRepository: {
    listMeetingsForContext: (...args: unknown[]) => listMeetingsForContext(...args),
  },
  transcriptsRepository: {
    findByMeetingIds: (...args: unknown[]) => findByMeetingIds(...args),
    findById: (...args: unknown[]) => findById(...args),
  },
  transcriptArtifactsRepository: {
    findByTranscriptAndKind: (...args: unknown[]) => findByTranscriptAndKind(...args),
  },
}));

const ENGAGEMENT_ID = '11111111-1111-1111-1111-111111111111';
const MEETING_ID = '22222222-2222-2222-2222-222222222222';
const TRANSCRIPT_ID = '33333333-3333-3333-3333-333333333333';

describe('invariant: buildCaseHistoryInput — the shape check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('⚠⚠ the output key set is EXACTLY {messages:[author,sentAt,text], transcripts:[heldAt,source,text]} — even when the underlying rows carry money-ish fields', async () => {
    const { buildCaseHistoryInput } = await import('../services/project-brief/case-history.js');

    // Every mocked row below carries at least one field this invariant forbids, attached to
    // prove it cannot ride along into the narrowed output.
    findByContext.mockResolvedValue({ id: 'conv-1' });
    listMessages.mockResolvedValue([
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        senderUserId: 'user-client',
        body: 'Can we fix the sandbox refresh job?',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        // ⚠ money-ish fields a careless projection could leak.
        rateCents: 15000,
        currency: 'aud',
        creditSessionId: 'cs-1',
      },
    ]);
    listMeetingsForContext.mockResolvedValue([
      {
        id: MEETING_ID,
        scheduledStart: new Date('2026-01-02T00:00:00Z'),
        // ⚠ money-ish fields a careless projection could leak.
        durationMs: 1_800_000,
        baloFeeBps: 2500,
      },
    ]);
    findByMeetingIds.mockResolvedValue(
      new Map([[MEETING_ID, { id: TRANSCRIPT_ID, status: 'completed', meetingId: MEETING_ID }]])
    );
    findByTranscriptAndKind.mockResolvedValue(undefined); // force the canonical-segment fallback
    findById.mockResolvedValue({
      id: TRANSCRIPT_ID,
      canonical: {
        schemaVersion: 1,
        vendor: 'daily_deepgram',
        language: 'en',
        fillerWords: false,
        speakers: [],
        segments: [
          {
            index: 0,
            speakerRef: 'speaker-0',
            startMs: 0,
            endMs: 1000,
            text: 'Hi.',
            confidence: 1,
          },
        ],
        // ⚠ money-adjacent field this module must never read.
        durationMs: 60_000,
      },
      // ⚠ a top-level money-adjacent field on the row itself.
      durationMs: 60_000,
      currency: 'aud',
    });

    const result = await buildCaseHistoryInput({
      engagementId: ENGAGEMENT_ID,
      expertUserIds: ['user-expert'],
    });

    expect(Object.keys(result).sort((a, b) => a.localeCompare(b))).toEqual([
      'messages',
      'transcripts',
    ]);

    const [firstMessage] = result.messages;
    if (firstMessage === undefined) throw new Error('expected one message in the fixture');
    expect(Object.keys(firstMessage).sort((a, b) => a.localeCompare(b))).toEqual([
      'author',
      'sentAt',
      'text',
    ]);

    const [firstTranscript] = result.transcripts;
    if (firstTranscript === undefined) throw new Error('expected one transcript in the fixture');
    expect(Object.keys(firstTranscript).sort((a, b) => a.localeCompare(b))).toEqual([
      'heldAt',
      'source',
      'text',
    ]);
  });
});
