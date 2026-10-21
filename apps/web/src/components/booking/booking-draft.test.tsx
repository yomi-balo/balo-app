import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOKING_DRAFT_KEY_PREFIX,
  BOOKING_DRAFT_TTL_MS,
  clearAllBookingDrafts,
  clearBookingDrafts,
  readBookingDraft,
  writeBookingDraft,
  type BookingDraft,
} from './booking-draft';

const SCOPE = { ownerUserId: 'user-1', expertProfileId: 'expert-1' };
const NOW = 1_800_000_000_000;

const DRAFT: BookingDraft = {
  title: 'Migration planning',
  descriptionHtml: '<p>A real problem statement.</p>',
  productIds: ['product-1'],
  guests: [{ email: 'sam@northwind.com', name: 'Sam' }, { email: 'kit@northwind.com' }],
  caseSelection: { kind: 'new' },
  companyId: 'company-1',
};

function keyFor(owner: string, expert: string, company: string): string {
  return `${BOOKING_DRAFT_KEY_PREFIX}${owner}:${expert}:${company}`;
}

beforeEach(() => {
  globalThis.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('booking draft', () => {
  it('round-trips a draft for the same owner, expert and company', () => {
    writeBookingDraft(SCOPE, DRAFT, NOW);

    expect(readBookingDraft(SCOPE, ['company-1'], NOW)).toEqual(DRAFT);
  });

  it('keys the entry by owner, expert and company', () => {
    writeBookingDraft(SCOPE, DRAFT, NOW);

    expect(
      globalThis.localStorage.getItem(keyFor('user-1', 'expert-1', 'company-1'))
    ).not.toBeNull();
  });

  it('never stores a time', () => {
    writeBookingDraft(SCOPE, DRAFT, NOW);

    const raw = globalThis.localStorage.getItem(keyFor('user-1', 'expert-1', 'company-1')) ?? '';
    expect(raw).not.toContain('startIso');
    expect(raw).not.toContain('endIso');
    expect(raw).not.toContain('slot');
  });

  it("never reads another user's draft", () => {
    writeBookingDraft({ ...SCOPE, ownerUserId: 'user-2' }, DRAFT, NOW);

    expect(readBookingDraft(SCOPE, ['company-1'], NOW)).toBeNull();
  });

  it("never reads another expert's draft", () => {
    writeBookingDraft({ ...SCOPE, expertProfileId: 'expert-2' }, DRAFT, NOW);

    expect(readBookingDraft(SCOPE, ['company-1'], NOW)).toBeNull();
  });

  it('expires after seven days and removes the entry', () => {
    writeBookingDraft(SCOPE, DRAFT, NOW);
    const later = NOW + BOOKING_DRAFT_TTL_MS + 1;

    expect(readBookingDraft(SCOPE, ['company-1'], later)).toBeNull();
    expect(globalThis.localStorage.getItem(keyFor('user-1', 'expert-1', 'company-1'))).toBeNull();
  });

  it('still reads on the last day', () => {
    writeBookingDraft(SCOPE, DRAFT, NOW);

    expect(readBookingDraft(SCOPE, ['company-1'], NOW + BOOKING_DRAFT_TTL_MS)).toEqual(DRAFT);
  });

  it('skips a company the viewer is no longer eligible for, and keeps the entry', () => {
    writeBookingDraft(SCOPE, DRAFT, NOW);

    expect(readBookingDraft(SCOPE, ['company-9'], NOW)).toBeNull();
    expect(
      globalThis.localStorage.getItem(keyFor('user-1', 'expert-1', 'company-1'))
    ).not.toBeNull();
  });

  it('returns the freshest draft among eligible companies', () => {
    writeBookingDraft(SCOPE, { ...DRAFT, title: 'Older', companyId: 'company-1' }, NOW);
    writeBookingDraft(SCOPE, { ...DRAFT, title: 'Newer', companyId: 'company-2' }, NOW + 1000);

    expect(readBookingDraft(SCOPE, ['company-1', 'company-2'], NOW + 2000)?.title).toBe('Newer');
    expect(readBookingDraft(SCOPE, ['company-1'], NOW + 2000)?.title).toBe('Older');
  });

  it('skips and removes malformed JSON', () => {
    const key = keyFor('user-1', 'expert-1', 'company-1');
    globalThis.localStorage.setItem(key, '{not json');

    expect(readBookingDraft(SCOPE, ['company-1'], NOW)).toBeNull();
    expect(globalThis.localStorage.getItem(key)).toBeNull();
  });

  it('removes an entry with the wrong shape', () => {
    const key = keyFor('user-1', 'expert-1', 'company-1');
    globalThis.localStorage.setItem(key, JSON.stringify({ v: 1, savedAt: NOW, title: 4 }));

    expect(readBookingDraft(SCOPE, ['company-1'], NOW)).toBeNull();
    expect(globalThis.localStorage.getItem(key)).toBeNull();
  });

  it('narrows a hand-edited entry to safe values', () => {
    globalThis.localStorage.setItem(
      keyFor('user-1', 'expert-1', 'company-1'),
      JSON.stringify({
        v: 1,
        savedAt: NOW,
        title: 'T',
        descriptionHtml: '<p>D</p>',
        productIds: ['a', 7, 'b'],
        guests: [{ email: 'a@b.co' }, { email: 3 }, null, 'x'],
        caseSelection: { kind: 'existing' },
        companyId: 'company-1',
      })
    );

    expect(readBookingDraft(SCOPE, ['company-1'], NOW)).toEqual({
      title: 'T',
      descriptionHtml: '<p>D</p>',
      productIds: ['a', 'b'],
      guests: [{ email: 'a@b.co' }],
      caseSelection: { kind: 'new' },
      companyId: 'company-1',
    });
  });

  it('restores an existing-case selection', () => {
    writeBookingDraft(
      SCOPE,
      { ...DRAFT, caseSelection: { kind: 'existing', engagementId: 'engagement-1' } },
      NOW
    );

    expect(readBookingDraft(SCOPE, ['company-1'], NOW)?.caseSelection).toEqual({
      kind: 'existing',
      engagementId: 'engagement-1',
    });
  });

  it('clearBookingDrafts removes every company for the owner and expert only', () => {
    writeBookingDraft(SCOPE, DRAFT, NOW);
    writeBookingDraft(SCOPE, { ...DRAFT, companyId: 'company-2' }, NOW);
    writeBookingDraft({ ...SCOPE, expertProfileId: 'expert-2' }, DRAFT, NOW);

    clearBookingDrafts(SCOPE);

    expect(readBookingDraft(SCOPE, ['company-1', 'company-2'], NOW)).toBeNull();
    expect(readBookingDraft({ ...SCOPE, expertProfileId: 'expert-2' }, ['company-1'], NOW)).toEqual(
      DRAFT
    );
  });

  it('clearAllBookingDrafts sweeps every booking draft and leaves other keys alone', () => {
    writeBookingDraft(SCOPE, DRAFT, NOW);
    writeBookingDraft({ ownerUserId: 'user-2', expertProfileId: 'expert-9' }, DRAFT, NOW);
    globalThis.localStorage.setItem('balo:project-draft:expert-1', 'keep');
    globalThis.localStorage.setItem('unrelated', 'keep');

    clearAllBookingDrafts();

    expect(readBookingDraft(SCOPE, ['company-1'], NOW)).toBeNull();
    expect(globalThis.localStorage.getItem('balo:project-draft:expert-1')).toBe('keep');
    expect(globalThis.localStorage.getItem('unrelated')).toBe('keep');
  });

  it('is a no-op when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied');
    });

    expect(() => writeBookingDraft(SCOPE, DRAFT, NOW)).not.toThrow();
    expect(readBookingDraft(SCOPE, ['company-1'], NOW)).toBeNull();
    expect(() => clearBookingDrafts(SCOPE)).not.toThrow();
    expect(() => clearAllBookingDrafts()).not.toThrow();
  });

  it('is a no-op when the storage accessor itself throws', () => {
    vi.spyOn(globalThis, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });

    expect(() => writeBookingDraft(SCOPE, DRAFT, NOW)).not.toThrow();
    expect(readBookingDraft(SCOPE, ['company-1'], NOW)).toBeNull();
  });
});
