import { describe, it, expect, vi, beforeEach } from 'vitest';

const MEETING_ID = 'a0000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'b0000000-0000-4000-8000-000000000002';
const OTHER_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));

const mockFindNames = vi.fn();
vi.mock('@balo/db', () => ({
  usersRepository: { findNamesByIds: (...a: unknown[]) => mockFindNames(...a) },
  isTwoSidedParty: (party: unknown) => party === 'client' || party === 'expert',
}));

import { mapRecapFiles } from './map-recap-files';
import { log } from '@/lib/logging';

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f1',
    meetingId: MEETING_ID,
    uploadedByUserId: OTHER_ID,
    party: 'expert',
    source: 'files_tab',
    // ⚠ THE FIXTURE CARRIES AN r2Key ON PURPOSE — the assertions below prove the mapper drops
    // it. It is the OBJECT LOCATOR the presigner signs, and it must never cross the wire.
    r2Key: 'meeting-files/' + MEETING_ID + '/' + OTHER_ID + '/leaf',
    fileName: 'deck.pdf',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    createdAt: new Date('2026-07-29T05:00:00Z'),
    updatedAt: new Date('2026-07-29T05:00:00Z'),
    deletedAt: null,
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asRows = (rows: Record<string, unknown>[]) => rows as any;

describe('mapRecapFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindNames.mockResolvedValue([{ id: OTHER_ID, firstName: 'Amara', lastName: 'Okafor' }]);
  });

  it('NEVER emits r2Key', async () => {
    const out = await mapRecapFiles(asRows([row()]), VIEWER_ID);
    expect(JSON.stringify(out)).not.toContain('meeting-files/');
    expect(JSON.stringify(out)).not.toContain('r2Key');
    expect(Object.keys(out[0]?.file ?? {})).not.toContain('r2Key');
  });

  it("labels the viewer's own uploads as You, with no lookup for them", async () => {
    const out = await mapRecapFiles(asRows([row({ uploadedByUserId: VIEWER_ID })]), VIEWER_ID);
    expect(out[0]?.uploaderLabel).toBe('You');
    expect(mockFindNames).toHaveBeenCalledWith([]);
  });

  it('labels another uploader by FIRST NAME only — never a full name, never an email', async () => {
    const out = await mapRecapFiles(asRows([row()]), VIEWER_ID);
    expect(out[0]?.uploaderLabel).toBe('Amara');
    expect(JSON.stringify(out)).not.toContain('Okafor');
    expect(JSON.stringify(out)).not.toContain('@');
  });

  it('batches ONE lookup over the DISTINCT uploader set, never one per file', async () => {
    await mapRecapFiles(
      asRows([
        row({ id: 'f1' }),
        row({ id: 'f2' }),
        row({ id: 'f3', uploadedByUserId: VIEWER_ID }),
      ]),
      VIEWER_ID
    );
    expect(mockFindNames).toHaveBeenCalledTimes(1);
    expect(mockFindNames).toHaveBeenCalledWith([OTHER_ID]);
  });

  it('falls back to a neutral label when the uploader row cannot be resolved', async () => {
    mockFindNames.mockResolvedValue([]);
    const out = await mapRecapFiles(asRows([row()]), VIEWER_ID);
    expect(out[0]?.uploaderLabel).toBe('Someone');
  });

  it('DROPS a row whose party is not two-sided, and says so in the log', async () => {
    const out = await mapRecapFiles(
      asRows([row({ party: 'admin' }), row({ id: 'f2' })]),
      VIEWER_ID
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.file.id).toBe('f2');
    expect(log.warn).toHaveBeenCalled();
  });

  it('serialises createdAt as an ISO string', async () => {
    const out = await mapRecapFiles(asRows([row()]), VIEWER_ID);
    expect(out[0]?.file.createdAtIso).toBe('2026-07-29T05:00:00.000Z');
  });

  it('returns an empty list for no files, with no lookup work', async () => {
    const out = await mapRecapFiles(asRows([]), VIEWER_ID);
    expect(out).toEqual([]);
    expect(mockFindNames).toHaveBeenCalledWith([]);
  });
});
