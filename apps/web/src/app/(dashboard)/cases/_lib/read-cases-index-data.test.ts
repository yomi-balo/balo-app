import { describe, expect, it, vi, beforeEach } from 'vitest';
import { log } from '@/lib/logging';
import { readCasesIndexData } from './read-cases-index-data';
import type { CasesIndexData } from './cases-index-view-types';

const READY: CasesIndexData = {
  kind: 'ready',
  side: 'company',
  companyName: 'Acme Corp',
  featured: null,
  open: [],
  openHasMore: false,
  openCursor: null,
  openCount: 0,
  resolvedCount: 0,
  empty: 'no_cases',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readCasesIndexData', () => {
  it('passes a successful read straight through', async () => {
    await expect(readCasesIndexData(() => Promise.resolve(READY), {})).resolves.toEqual(READY);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('turns a THROWN read into the error state, and logs the original', async () => {
    const data = await readCasesIndexData(
      () => Promise.reject(new Error('relation does not exist')),
      { workspaceType: 'company', companyId: 'co-1' }
    );

    expect(data).toEqual({ kind: 'error' });
    // ⚠ THE ORIGINAL ERROR IS THE WHOLE POINT. This boundary SWALLOWS it, so without the log
    // line the SQL failure would be gone for good.
    expect(log.error).toHaveBeenCalledWith(
      'Cases index read failed',
      expect.objectContaining({
        workspaceType: 'company',
        companyId: 'co-1',
        error: 'relation does not exist',
        stack: expect.any(String),
      })
    );
  });

  it('catches a SYNCHRONOUS throw from the thunk too', async () => {
    const data = await readCasesIndexData(() => {
      throw new Error('boom');
    }, {});
    expect(data).toEqual({ kind: 'error' });
  });

  it('stringifies a non-Error rejection rather than logging "undefined"', async () => {
    await readCasesIndexData(() => Promise.reject('just a string'), {});
    expect(log.error).toHaveBeenCalledWith(
      'Cases index read failed',
      expect.objectContaining({ error: 'just a string', stack: undefined })
    );
  });
});
