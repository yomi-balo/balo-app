import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { ProjectBriefDraftPatch } from '@/lib/project-request/actions/get-project-brief-parse';

vi.mock('server-only', () => ({}));

/**
 * The polling hook is stubbed so this suite can invoke `onSucceeded` DIRECTLY — that callback is
 * what `useAiBriefFlow` guards, and reaching it through a real 2s interval would make a fast,
 * deterministic test slow and flaky for no extra coverage.
 */
const captured: { onSucceeded?: (patch: ProjectBriefDraftPatch) => void } = {};
const mockStart = vi.fn();
const mockDismissFailure = vi.fn();
const mockCancel = vi.fn();

vi.mock('./use-project-brief-generation', () => ({
  useProjectBriefGeneration: (options: {
    onSucceeded: (patch: ProjectBriefDraftPatch) => void;
  }) => {
    captured.onSucceeded = options.onSucceeded;
    return {
      phase: 'generating' as const,
      headingIndex: 0 as const,
      failureReason: null,
      start: mockStart,
      dismissFailure: mockDismissFailure,
      cancel: mockCancel,
    };
  },
}));

import { useAiBriefFlow } from './use-ai-brief-flow';
import type { ProjectDraft } from './use-project-draft';

const DRAFT: ProjectDraft = {
  routing: 'direct',
  title: '',
  descriptionHtml: '',
  tagIds: [],
  productIds: [],
  documents: [],
  budgetMinCents: null,
  budgetMaxCents: null,
  timeline: null,
  source: 'ai',
};

/** ⚠ DRAFT.documents is EMPTY, which is itself a reset trigger. Use this where the test is
 *  about something other than the empty-documents reset. */
const DRAFT_WITH_DOC: ProjectDraft = {
  ...DRAFT,
  documents: [
    {
      r2Key: 'project-documents/c/u/k',
      fileName: 'spec.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1000,
    },
  ],
};

const PATCH: ProjectBriefDraftPatch = {
  title: '  AI-drafted title  ',
  descriptionHtml: '<p>drafted</p>',
  tagIds: ['t1'],
  productIds: ['p1'],
  unmatchedTagLabels: [],
  unmatchedProductLabels: [],
};

function renderFlow(isFlowActive: boolean, draft: ProjectDraft = DRAFT) {
  const setField = vi.fn();
  const setStep = vi.fn();
  const view = renderHook(
    ({ active, currentDraft }: { active: boolean; currentDraft: ProjectDraft }) =>
      useAiBriefFlow({
        expertProfileId: undefined,
        draft: currentDraft,
        setField,
        setStep,
        isFlowActive: active,
      }),
    { initialProps: { active: isFlowActive, currentDraft: draft } }
  );
  return { setField, setStep, view };
}

describe('useAiBriefFlow — the abandoned-flow guard (fix round F5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onSucceeded = undefined;
  });

  it('applies a successful parse while the flow is active', () => {
    const { setField, setStep } = renderFlow(true);
    act(() => captured.onSucceeded?.(PATCH));

    expect(setField).toHaveBeenCalledWith('title', PATCH.title);
    expect(setField).toHaveBeenCalledWith('descriptionHtml', PATCH.descriptionHtml);
    expect(setStep).toHaveBeenCalledWith('review');
  });

  it('⚠ writes NOTHING when the flow has been abandoned (drawer closed, or already submitted)', () => {
    // Closing the drawer does not unmount the panel, so the poll keeps running. A late success
    // would otherwise repopulate a draft the user cleared by submitting, and yank them off the
    // confirmation screen back to `review`.
    const { setField, setStep } = renderFlow(false);
    act(() => captured.onSucceeded?.(PATCH));

    expect(setField).not.toHaveBeenCalled();
    expect(setStep).not.toHaveBeenCalled();
  });
});

/**
 * ⚠⚠ THE STALE-FAILURE BUG. `isFlowActive` already declared the flow abandoned on close, and a
 * late SUCCESS was discarded — but nothing retired a FAILURE. Reported from the running app:
 * generate failed, the user removed the file, closed the drawer, reopened it, re-picked the AI
 * path, and met the previous attempt's banner over an empty dropzone — still claiming "Your
 * files are still attached".
 */
describe('useAiBriefFlow — a failed generate does not outlive its flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onSucceeded = undefined;
  });

  it('⚠ retires the generation when the flow is abandoned (drawer closed / submitted)', () => {
    const { view } = renderFlow(true, DRAFT_WITH_DOC);
    expect(mockCancel).not.toHaveBeenCalled();

    // Closing the drawer flips `isFlowActive` — the panel is NOT unmounted.
    act(() => view.rerender({ active: false, currentDraft: DRAFT_WITH_DOC }));

    expect(mockCancel).toHaveBeenCalled();
  });

  it('⚠ retires the generation when the LAST document is removed', () => {
    const { view } = renderFlow(true, DRAFT_WITH_DOC);
    expect(mockCancel).not.toHaveBeenCalled();

    // The X on the only attached file — the banner's "Your files are still attached" is now false.
    act(() => view.rerender({ active: true, currentDraft: DRAFT }));

    expect(mockCancel).toHaveBeenCalled();
  });

  it('keeps the generation while the flow is active and a document remains', () => {
    const twoDocs: ProjectDraft = {
      ...DRAFT_WITH_DOC,
      documents: [
        ...DRAFT_WITH_DOC.documents,
        {
          r2Key: 'project-documents/c/u/k2',
          fileName: 'notes.pdf',
          contentType: 'application/pdf',
          sizeBytes: 2000,
        },
      ],
    };
    const { view } = renderFlow(true, twoDocs);

    // Removing ONE of several leaves the banner's copy true and Try again with input.
    act(() => view.rerender({ active: true, currentDraft: DRAFT_WITH_DOC }));

    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe('useAiBriefFlow — the regenerate clobber-guard snapshot (fix round F15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.onSucceeded = undefined;
  });

  it('⚠ a title with surrounding whitespace does not count as an edit', () => {
    // `hasEditsSinceGenerate` compares the snapshot against `draft.title.trim()`. Storing the
    // RAW model title meant a single trailing space tripped the "you have edits, they'll be
    // replaced" dialog on a draft nobody had touched.
    const setField = vi.fn();
    const { result, rerender } = renderHook(
      ({ draft }: { draft: ProjectDraft }) =>
        useAiBriefFlow({
          expertProfileId: undefined,
          draft,
          setField,
          setStep: vi.fn(),
          isFlowActive: true,
        }),
      { initialProps: { draft: DRAFT } }
    );

    act(() => captured.onSucceeded?.(PATCH));

    // What the panel's draft holds after the patch is applied: the RAW (untrimmed) title.
    rerender({
      draft: {
        ...DRAFT,
        title: PATCH.title,
        descriptionHtml: PATCH.descriptionHtml,
        tagIds: [...PATCH.tagIds],
        productIds: [...PATCH.productIds],
      },
    });

    expect(result.current.hasEditsSinceGenerate).toBe(false);
  });
});
