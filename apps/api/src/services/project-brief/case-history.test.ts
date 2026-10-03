import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCaseHistoryInput, renderCaseHistory } from './case-history.js';

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
const CLIENT_USER = 'client-user-1';
const EXPERT_USER = 'expert-user-1';

/** A canonical transcript carrying exactly one segment of `text`. */
function canonicalWith(text: string): {
  schemaVersion: 1;
  vendor: 'daily_deepgram';
  language: string | null;
  fillerWords: boolean;
  speakers: never[];
  segments: Array<{
    index: number;
    speakerRef: string;
    startMs: number;
    endMs: number;
    text: string;
    confidence: number | null;
  }>;
  durationMs: number | null;
} {
  return {
    schemaVersion: 1,
    vendor: 'daily_deepgram',
    language: 'en',
    fillerWords: false,
    speakers: [],
    segments: [{ index: 0, speakerRef: 'speaker-0', startMs: 0, endMs: 1000, text, confidence: 1 }],
    durationMs: 60_000,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildCaseHistoryInput', () => {
  it('returns empty lists when the case has no conversation and no meetings', async () => {
    findByContext.mockResolvedValue(undefined);
    listMeetingsForContext.mockResolvedValue([]);

    const result = await buildCaseHistoryInput({
      engagementId: ENGAGEMENT_ID,
      expertUserIds: [EXPERT_USER],
    });

    expect(result).toEqual({ messages: [], transcripts: [] });
  });

  it("labels a sender in expertUserIds 'expert', and every other sender 'client'", async () => {
    findByContext.mockResolvedValue({ id: 'conv-1' });
    listMessages.mockResolvedValue([
      { senderUserId: CLIENT_USER, body: 'Client message', createdAt: new Date('2026-01-01') },
      { senderUserId: EXPERT_USER, body: 'Expert message', createdAt: new Date('2026-01-02') },
    ]);
    listMeetingsForContext.mockResolvedValue([]);

    const result = await buildCaseHistoryInput({
      engagementId: ENGAGEMENT_ID,
      expertUserIds: [EXPERT_USER],
    });

    expect(result.messages).toEqual([
      { author: 'client', sentAt: new Date('2026-01-01'), text: 'Client message' },
      { author: 'expert', sentAt: new Date('2026-01-02'), text: 'Expert message' },
    ]);
  });

  it('⚠ the summary artifact is preferred over the canonical segment text', async () => {
    findByContext.mockResolvedValue(undefined);
    listMeetingsForContext.mockResolvedValue([
      { id: 'meeting-1', scheduledStart: new Date('2026-01-03') },
    ]);
    findByMeetingIds.mockResolvedValue(
      new Map([['meeting-1', { id: 'transcript-1', status: 'completed', meetingId: 'meeting-1' }]])
    );
    findByTranscriptAndKind.mockResolvedValue({ content: 'The summarised recap.' });

    const result = await buildCaseHistoryInput({
      engagementId: ENGAGEMENT_ID,
      expertUserIds: [EXPERT_USER],
    });

    expect(result.transcripts).toEqual([
      { heldAt: new Date('2026-01-03'), source: 'summary', text: 'The summarised recap.' },
    ]);
    // The canonical fallback was never consulted once a summary artifact was found.
    expect(findById).not.toHaveBeenCalled();
  });

  it('falls back to the joined canonical segment text when no summary artifact exists', async () => {
    findByContext.mockResolvedValue(undefined);
    listMeetingsForContext.mockResolvedValue([
      { id: 'meeting-1', scheduledStart: new Date('2026-01-03') },
    ]);
    findByMeetingIds.mockResolvedValue(
      new Map([['meeting-1', { id: 'transcript-1', status: 'completed', meetingId: 'meeting-1' }]])
    );
    findByTranscriptAndKind.mockResolvedValue(undefined);
    findById.mockResolvedValue({
      id: 'transcript-1',
      canonical: canonicalWith('Raw segment text.'),
    });

    const result = await buildCaseHistoryInput({
      engagementId: ENGAGEMENT_ID,
      expertUserIds: [EXPERT_USER],
    });

    expect(result.transcripts).toEqual([
      { heldAt: new Date('2026-01-03'), source: 'transcript', text: 'Raw segment text.' },
    ]);
  });

  it('each meeting pairs with its OWN ref under concurrent resolution', async () => {
    // Two meetings, resolved via `Promise.all` rather than a sequential loop: this pins
    // that meeting-2 never ends up reading meeting-1's transcript ref or vice versa.
    findByContext.mockResolvedValue(undefined);
    listMeetingsForContext.mockResolvedValue([
      { id: 'meeting-1', scheduledStart: new Date('2026-01-01') },
      { id: 'meeting-2', scheduledStart: new Date('2026-01-02') },
    ]);
    findByMeetingIds.mockResolvedValue(
      new Map([
        ['meeting-1', { id: 'transcript-1', status: 'completed', meetingId: 'meeting-1' }],
        ['meeting-2', { id: 'transcript-2', status: 'completed', meetingId: 'meeting-2' }],
      ])
    );
    findByTranscriptAndKind.mockImplementation((transcriptId: string) =>
      Promise.resolve(
        transcriptId === 'transcript-1' ? { content: 'Summary for meeting one.' } : undefined
      )
    );
    findById.mockImplementation((transcriptId: string) =>
      Promise.resolve(
        transcriptId === 'transcript-2'
          ? { id: 'transcript-2', canonical: canonicalWith('Raw text for meeting two.') }
          : undefined
      )
    );

    const result = await buildCaseHistoryInput({
      engagementId: ENGAGEMENT_ID,
      expertUserIds: [EXPERT_USER],
    });

    expect(result.transcripts).toEqual([
      { heldAt: new Date('2026-01-02'), source: 'transcript', text: 'Raw text for meeting two.' },
      { heldAt: new Date('2026-01-01'), source: 'summary', text: 'Summary for meeting one.' },
    ]);
  });

  it('⚠ reads only the newest CASE_HISTORY_MAX_TRANSCRIPTS (10) meetings', async () => {
    findByContext.mockResolvedValue(undefined);
    const meetings = Array.from({ length: 14 }, (_, i) => ({
      id: `meeting-${i}`,
      scheduledStart: new Date(2026, 0, i + 1),
    }));
    listMeetingsForContext.mockResolvedValue(meetings);
    findByMeetingIds.mockResolvedValue(new Map());

    await buildCaseHistoryInput({ engagementId: ENGAGEMENT_ID, expertUserIds: [EXPERT_USER] });

    const [requestedIds] = findByMeetingIds.mock.calls[0] as [string[]];
    expect(requestedIds).toHaveLength(10);
    // Newest first by `scheduledStart` — the last 10 meetings in the fixture, days 5–14.
    expect(requestedIds).toEqual([
      'meeting-13',
      'meeting-12',
      'meeting-11',
      'meeting-10',
      'meeting-9',
      'meeting-8',
      'meeting-7',
      'meeting-6',
      'meeting-5',
      'meeting-4',
    ]);
  });
});

describe('renderCaseHistory', () => {
  it('renders an empty input as empty, untruncated', () => {
    expect(renderCaseHistory({ messages: [], transcripts: [] }, 1000)).toEqual({
      text: '',
      truncated: false,
    });
  });

  it('renders a message and a transcript line chronologically, with the documented prefixes', () => {
    const result = renderCaseHistory(
      {
        messages: [
          { author: 'client', sentAt: new Date('2026-01-01T00:00:00Z'), text: 'Hello' },
          { author: 'expert', sentAt: new Date('2026-01-02T00:00:00Z'), text: 'Hi back' },
        ],
        transcripts: [
          { heldAt: new Date('2026-01-03T00:00:00Z'), source: 'summary', text: 'A recap.' },
        ],
      },
      1000
    );

    expect(result.truncated).toBe(false);
    expect(result.text).toBe(
      '[2026-01-01] Client: Hello\n[2026-01-02] Expert: Hi back\n[2026-01-03] Call summary: A recap.'
    );
  });

  it('⚠ truncation drops the OLDEST first and adds the marker', () => {
    const messages = [
      { author: 'client' as const, sentAt: new Date('2026-01-01'), text: 'oldest' },
      { author: 'client' as const, sentAt: new Date('2026-01-02'), text: 'middle' },
      { author: 'client' as const, sentAt: new Date('2026-01-03'), text: 'newest' },
    ];
    // Each rendered line is `[YYYY-MM-DD] Client: <text>` — 20 chars of prefix + text. Allow
    // room for exactly the two newest lines plus their separator, not the oldest.
    const newestLine = '[2026-01-03] Client: newest';
    const middleLine = '[2026-01-02] Client: middle';
    const maxChars = newestLine.length + 1 + middleLine.length;

    const result = renderCaseHistory({ messages, transcripts: [] }, maxChars);

    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('[Earlier case history omitted]\n')).toBe(true);
    expect(result.text).not.toContain('oldest');
    expect(result.text).toContain('middle');
    expect(result.text).toContain('newest');
    // Chronological order is preserved for what survives.
    expect(result.text.indexOf('middle')).toBeLessThan(result.text.indexOf('newest'));
  });

  it('⚠ a single oversize NEWEST item is trimmed to fit rather than dropped', () => {
    const longText = 'x'.repeat(200);
    const result = renderCaseHistory(
      {
        messages: [{ author: 'client', sentAt: new Date('2026-01-01'), text: longText }],
        transcripts: [],
      },
      50
    );

    expect(result.truncated).toBe(false); // it is the ONLY item — nothing else was dropped
    expect(result.text).toHaveLength(50);
    expect(result.text.startsWith('[2026-01-01] Client:')).toBe(true);
  });

  it('⚠ an oversize newest item with older items present is trimmed AND marked truncated', () => {
    const longText = 'x'.repeat(200);
    const result = renderCaseHistory(
      {
        messages: [
          { author: 'client', sentAt: new Date('2026-01-01'), text: 'older' },
          { author: 'client', sentAt: new Date('2026-01-02'), text: longText },
        ],
        transcripts: [],
      },
      50
    );

    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('older');
    expect(result.text).toHaveLength(50 + '[Earlier case history omitted]\n'.length);
  });
});
