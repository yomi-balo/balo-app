import { describe, it, expect, vi } from 'vitest';
import { flushAnonymousDraft } from './flush-anonymous-draft';
import type { AnonymousApplicationDraftV1 } from './anonymous-draft';

function envelope(steps: AnonymousApplicationDraftV1['steps'] = {}): AnonymousApplicationDraftV1 {
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    currentStep: 6,
    maxReachedStep: 6,
    steps,
  };
}

// ⚠ FIX round — the real envelope ALWAYS carries an `agency` key too
// (`buildAnonymousEnvelope` populates every `STEP_CONFIG` key unconditionally,
// including the self-advancing agency step). A fixture missing it made "agency is
// never posted" a vacuous assertion — it can't prove the step was SKIPPED if the
// envelope never had it to skip in the first place.
const FULL_STEPS: AnonymousApplicationDraftV1['steps'] = {
  profile: { yearStartedSalesforce: 2018 },
  agency: { agencyId: null },
  products: { productIds: ['p1'] },
  assessment: { ratings: [] },
  certifications: { certifications: [] },
  'work-history': { entries: [] },
  terms: { termsAccepted: true },
};

describe('flushAnonymousDraft', () => {
  it('hasServerDraft: true → superseded, post is never called', async () => {
    const post = vi.fn();
    const result = await flushAnonymousDraft({
      draft: envelope(FULL_STEPS),
      hasServerDraft: true,
      post,
    });

    expect(result).toEqual({ outcome: 'superseded', stepsFlushed: 0, expertProfileId: null });
    expect(post).not.toHaveBeenCalled();
  });

  it('happy path: posts profile first, then the four DB-writing steps in STEP_CONFIG order, each carrying expertProfileId; agency and terms are never posted', async () => {
    const post = vi.fn().mockResolvedValue({ success: true, expertProfileId: 'ep-1' });

    const result = await flushAnonymousDraft({
      draft: envelope(FULL_STEPS),
      hasServerDraft: false,
      post,
    });

    expect(result).toEqual({ outcome: 'flushed', stepsFlushed: 5, expertProfileId: 'ep-1' });

    expect(post).toHaveBeenNthCalledWith(1, { step: 'profile', data: FULL_STEPS.profile });
    expect(post).toHaveBeenNthCalledWith(2, {
      step: 'products',
      data: FULL_STEPS.products,
      expertProfileId: 'ep-1',
    });
    expect(post).toHaveBeenNthCalledWith(3, {
      step: 'assessment',
      data: FULL_STEPS.assessment,
      expertProfileId: 'ep-1',
    });
    expect(post).toHaveBeenNthCalledWith(4, {
      step: 'certifications',
      data: FULL_STEPS.certifications,
      expertProfileId: 'ep-1',
    });
    expect(post).toHaveBeenNthCalledWith(5, {
      step: 'work-history',
      data: FULL_STEPS['work-history'],
      expertProfileId: 'ep-1',
    });
    expect(post).toHaveBeenCalledTimes(5);

    for (const call of post.mock.calls) {
      const [body] = call as [{ step: string }];
      expect(body.step).not.toBe('agency');
      expect(body.step).not.toBe('terms');
    }
  });

  it('call #1 (profile) returning { success: false } → failed, no subsequent calls', async () => {
    const post = vi.fn().mockResolvedValue({ success: false, expertProfileId: '' });

    const result = await flushAnonymousDraft({
      draft: envelope(FULL_STEPS),
      hasServerDraft: false,
      post,
    });

    expect(result).toEqual({ outcome: 'failed', stepsFlushed: 0, expertProfileId: null });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a mid-sequence { success: false } → failed, stepsFlushed reflects only the landed calls', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ success: true, expertProfileId: 'ep-1' }) // profile
      .mockResolvedValueOnce({ success: true, expertProfileId: 'ep-1' }) // products
      .mockResolvedValueOnce({ success: false, expertProfileId: 'ep-1' }); // assessment fails

    const result = await flushAnonymousDraft({
      draft: envelope(FULL_STEPS),
      hasServerDraft: false,
      post,
    });

    expect(result).toEqual({ outcome: 'failed', stepsFlushed: 2, expertProfileId: 'ep-1' });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it('an empty steps object → nothing_to_flush, no calls', async () => {
    const post = vi.fn();
    const result = await flushAnonymousDraft({
      draft: envelope({}),
      hasServerDraft: false,
      post,
    });

    expect(result).toEqual({ outcome: 'nothing_to_flush', stepsFlushed: 0, expertProfileId: null });
    expect(post).not.toHaveBeenCalled();
  });

  it('post rejecting on the profile call → failed, no throw', async () => {
    const post = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(
      flushAnonymousDraft({ draft: envelope(FULL_STEPS), hasServerDraft: false, post })
    ).resolves.toEqual({ outcome: 'failed', stepsFlushed: 0, expertProfileId: null });
  });

  it('post rejecting mid-sequence → failed, no throw, stepsFlushed reflects landed calls', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ success: true, expertProfileId: 'ep-1' })
      .mockRejectedValueOnce(new Error('network down'));

    await expect(
      flushAnonymousDraft({ draft: envelope(FULL_STEPS), hasServerDraft: false, post })
    ).resolves.toEqual({ outcome: 'failed', stepsFlushed: 1, expertProfileId: 'ep-1' });
  });

  it('the default post hits POST /api/expert/apply/flush-draft with JSON headers and body (no injected post)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true, expertProfileId: 'ep-1' })));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;

    try {
      const result = await flushAnonymousDraft({
        draft: envelope({ profile: FULL_STEPS.profile }),
        hasServerDraft: false,
      });

      expect(result).toEqual({ outcome: 'flushed', stepsFlushed: 1, expertProfileId: 'ep-1' });
      expect(fetchMock).toHaveBeenCalledWith('/api/expert/apply/flush-draft', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: 'profile', data: FULL_STEPS.profile }),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('skips a DB-writing step whose data is absent from the envelope', async () => {
    const post = vi.fn().mockResolvedValue({ success: true, expertProfileId: 'ep-1' });
    const partial: AnonymousApplicationDraftV1['steps'] = {
      profile: FULL_STEPS.profile,
      products: FULL_STEPS.products,
      // assessment, certifications, work-history omitted
    };

    const result = await flushAnonymousDraft({
      draft: envelope(partial),
      hasServerDraft: false,
      post,
    });

    expect(result).toEqual({ outcome: 'flushed', stepsFlushed: 2, expertProfileId: 'ep-1' });
    expect(post).toHaveBeenCalledTimes(2);
  });
});
