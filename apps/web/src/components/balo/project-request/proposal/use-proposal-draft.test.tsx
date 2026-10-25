import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  DRAFT_DEADLINE_MS,
  PROPOSAL_DRAFT_MAX_POLLS,
  PROPOSAL_DRAFT_POLL_INTERVAL_MS,
} from '@balo/shared/project-requests';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import type {
  ProposalDraftGenerationView,
  ProposalDraftPatch,
} from '@/lib/project-request/proposal/proposal-draft-types';

vi.mock('server-only', () => ({}));

const mockStart = vi.fn();
const mockPoll = vi.fn();
const mockCaptureException = vi.fn();

vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/start-proposal-draft', () => ({
  startProposalDraftAction: (...args: unknown[]) => mockStart(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/get-proposal-draft', () => ({
  getProposalDraftAction: (...args: unknown[]) => mockPoll(...args),
}));
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { useProposalDraft } from './use-proposal-draft';

const REQUEST_ID = 'req-1';
const RELATIONSHIP_ID = 'rel-1';
const PATCH: ProposalDraftPatch = {
  overviewHtml: '<p>Drafted</p>',
  milestones: [
    { title: 'Discovery', descriptionHtml: '<p>a</p>', acceptanceCriteria: 'Signed off' },
    { title: 'Build', descriptionHtml: '<p>b</p>', acceptanceCriteria: 'Demo passes' },
  ],
};

function setup(
  initial: ProposalDraftGenerationView | null,
  enabled = true
): {
  onDraft: ReturnType<typeof vi.fn>;
  hook: ReturnType<typeof renderHook<ReturnType<typeof useProposalDraft>, unknown>>;
} {
  const onDraft = vi.fn();
  const hook = renderHook(() =>
    useProposalDraft({
      enabled,
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      initial,
      onDraft,
    })
  );
  return { onDraft, hook };
}

async function tick(ms = PROPOSAL_DRAFT_POLL_INTERVAL_MS): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useProposalDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is idle and calls nothing when disabled', async () => {
    const { hook } = setup({ status: 'none' }, false);
    await tick();
    expect(hook.result.current).toMatchObject({ drafting: false, failed: false });
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it('is idle when there is no generation view', async () => {
    const { hook } = setup(null);
    await tick();
    expect(hook.result.current.drafting).toBe(false);
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('starts a generation on mount when none exists, then applies the draft from the poll', async () => {
    mockStart.mockResolvedValue({ status: 'pending', generationId: 'gen-1' });
    mockPoll.mockResolvedValue({ status: 'succeeded', generationId: 'gen-1', patch: PATCH });
    const { onDraft, hook } = setup({ status: 'none' });

    expect(hook.result.current.drafting).toBe(true);
    await tick(0);
    expect(mockStart).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
    });

    await tick();
    expect(mockPoll).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      relationshipId: RELATIONSHIP_ID,
      generationId: 'gen-1',
    });
    expect(onDraft).toHaveBeenCalledWith(PATCH);
    expect(hook.result.current).toMatchObject({
      drafting: false,
      failed: false,
      overviewDrafted: true,
      milestonesDrafted: true,
    });
  });

  it('applies a draft the start action already finished', async () => {
    mockStart.mockResolvedValue({ status: 'succeeded', generationId: 'gen-1', patch: PATCH });
    const { onDraft, hook } = setup({ status: 'none' });
    await tick(0);
    expect(onDraft).toHaveBeenCalledWith(PATCH);
    expect(hook.result.current.overviewDrafted).toBe(true);
  });

  it('resumes polling a pending generation without starting a new one', async () => {
    mockPoll.mockResolvedValue({ status: 'pending', generationId: 'gen-9' });
    setup({ status: 'pending', generationId: 'gen-9' });
    await tick();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockPoll).toHaveBeenCalledTimes(1);
    await tick();
    expect(mockPoll).toHaveBeenCalledTimes(2);
  });

  it('shows both badges for a draft already applied on the server, without calling anything', async () => {
    const { onDraft, hook } = setup({ status: 'succeeded', generationId: 'g', patch: PATCH });
    await tick();
    expect(hook.result.current).toMatchObject({
      drafting: false,
      overviewDrafted: true,
      milestonesDrafted: true,
    });
    expect(onDraft).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it('shows the failure line for a failed generation, and nothing for a skipped one', () => {
    expect(setup({ status: 'failed' }).hook.result.current.failed).toBe(true);
    const skipped = setup({ status: 'skipped' }).hook.result.current;
    expect(skipped).toMatchObject({ drafting: false, failed: false });
  });

  it('fails when the start action reports failure', async () => {
    mockStart.mockResolvedValue({ status: 'failed' });
    const { hook } = setup({ status: 'none' });
    await tick(0);
    expect(hook.result.current).toMatchObject({ drafting: false, failed: true });
  });

  it('goes quiet when the start action skips', async () => {
    mockStart.mockResolvedValue({ status: 'skipped' });
    const { hook } = setup({ status: 'none' });
    await tick(0);
    expect(hook.result.current).toMatchObject({ drafting: false, failed: false });
  });

  it('keeps polling a pending view past 80s, leaving the deadline to the server', async () => {
    mockPoll.mockResolvedValue({ status: 'pending', generationId: 'gen-1' });
    const { hook } = setup({ status: 'pending', generationId: 'gen-1' });
    const pollsPastEightySeconds = 80_000 / PROPOSAL_DRAFT_POLL_INTERVAL_MS + 5;
    for (let i = 0; i < pollsPastEightySeconds; i += 1) {
      await tick();
    }
    expect(mockPoll).toHaveBeenCalledTimes(pollsPastEightySeconds);
    expect(hook.result.current).toMatchObject({ drafting: true, failed: false });
  });

  it('stops polling on the failed view the server derives at its deadline', async () => {
    const pollsBeforeDeadline = DRAFT_DEADLINE_MS / PROPOSAL_DRAFT_POLL_INTERVAL_MS;
    let polls = 0;
    mockPoll.mockImplementation(async () => {
      polls += 1;
      return polls <= pollsBeforeDeadline
        ? { status: 'pending', generationId: 'gen-1' }
        : { status: 'failed' };
    });
    const { hook } = setup({ status: 'pending', generationId: 'gen-1' });
    for (let i = 0; i <= pollsBeforeDeadline; i += 1) {
      await tick();
    }
    expect(mockPoll).toHaveBeenCalledTimes(pollsBeforeDeadline + 1);
    expect(hook.result.current).toMatchObject({ drafting: false, failed: true });

    await tick(PROPOSAL_DRAFT_POLL_INTERVAL_MS * 3);
    expect(mockPoll).toHaveBeenCalledTimes(pollsBeforeDeadline + 1);
  });

  it('fails after the poll cap while still pending', async () => {
    mockPoll.mockResolvedValue({ status: 'pending', generationId: 'gen-1' });
    const { hook } = setup({ status: 'pending', generationId: 'gen-1' });
    for (let i = 0; i < PROPOSAL_DRAFT_MAX_POLLS; i += 1) {
      await tick();
    }
    expect(mockPoll).toHaveBeenCalledTimes(PROPOSAL_DRAFT_MAX_POLLS);
    expect(hook.result.current.failed).toBe(true);
    await tick(PROPOSAL_DRAFT_POLL_INTERVAL_MS * 3);
    expect(mockPoll).toHaveBeenCalledTimes(PROPOSAL_DRAFT_MAX_POLLS);
  });

  it('reports an unexpected throw to Sentry and fails quietly', async () => {
    const boom = new Error('network');
    mockStart.mockRejectedValue(boom);
    const { hook } = setup({ status: 'none' });
    await tick(0);
    expect(mockCaptureException).toHaveBeenCalledWith(boom);
    expect(hook.result.current.failed).toBe(true);
  });

  it('reports a poll throw to Sentry and fails quietly', async () => {
    const boom = new Error('network');
    mockPoll.mockRejectedValue(boom);
    const { hook } = setup({ status: 'pending', generationId: 'gen-1' });
    await tick();
    expect(mockCaptureException).toHaveBeenCalledWith(boom);
    expect(hook.result.current.failed).toBe(true);
  });

  it('discards the whole draft when the expert edits a section while drafting', async () => {
    mockPoll.mockResolvedValue({ status: 'succeeded', generationId: 'gen-1', patch: PATCH });
    const { onDraft, hook } = setup({ status: 'pending', generationId: 'gen-1' });

    act(() => hook.result.current.noteEdit('overview'));
    expect(hook.result.current).toMatchObject({
      drafting: false,
      failed: false,
      overviewDrafted: false,
      milestonesDrafted: false,
    });

    await tick(PROPOSAL_DRAFT_POLL_INTERVAL_MS * 3);
    expect(mockPoll).not.toHaveBeenCalled();
    expect(onDraft).not.toHaveBeenCalled();
  });

  it('tracks the discard once, with the relationship, however many edits follow', () => {
    const { hook } = setup({ status: 'pending', generationId: 'gen-1' });

    act(() => hook.result.current.noteEdit('overview'));
    act(() => hook.result.current.noteEdit('milestones'));
    act(() => hook.result.current.noteEdit('overview'));

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_DRAFT_DISCARDED, {
      relationship_id: RELATIONSHIP_ID,
    });
  });

  it('tracks no discard for an edit once drafting is over', () => {
    const succeeded = setup({ status: 'succeeded', generationId: 'g', patch: PATCH });
    act(() => succeeded.hook.result.current.noteEdit('overview'));
    const failed = setup({ status: 'failed' });
    act(() => failed.hook.result.current.noteEdit('milestones'));

    expect(track).not.toHaveBeenCalled();
  });

  it('ignores a poll result that was already in flight when the expert edited', async () => {
    let resolvePoll: (view: ProposalDraftGenerationView) => void = () => undefined;
    mockPoll.mockReturnValue(
      new Promise<ProposalDraftGenerationView>((resolve) => {
        resolvePoll = resolve;
      })
    );
    const { onDraft, hook } = setup({ status: 'pending', generationId: 'gen-1' });
    await tick();
    expect(mockPoll).toHaveBeenCalledTimes(1);

    act(() => hook.result.current.noteEdit('milestones'));
    await act(async () => {
      resolvePoll({ status: 'succeeded', generationId: 'gen-1', patch: PATCH });
      await Promise.resolve();
    });

    expect(onDraft).not.toHaveBeenCalled();
    expect(hook.result.current.overviewDrafted).toBe(false);
  });

  it('clears only the edited section badge, and hides the failure line, after a draft', async () => {
    const { hook } = setup({ status: 'succeeded', generationId: 'g', patch: PATCH });
    act(() => hook.result.current.noteEdit('overview'));
    expect(hook.result.current).toMatchObject({
      overviewDrafted: false,
      milestonesDrafted: true,
    });

    const failed = setup({ status: 'failed' });
    act(() => failed.hook.result.current.noteEdit('milestones'));
    expect(failed.hook.result.current.failed).toBe(false);
  });

  it('noteClear tracks the section with the relationship and clears its badge', () => {
    const { hook } = setup({ status: 'succeeded', generationId: 'g', patch: PATCH });
    act(() => hook.result.current.noteClear('milestones'));

    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROPOSAL_DRAFT_CLEARED, {
      section: 'milestones',
      relationship_id: RELATIONSHIP_ID,
    });
    expect(hook.result.current).toMatchObject({ overviewDrafted: true, milestonesDrafted: false });
  });

  it('noteRestore puts a cleared section badge back without tracking', () => {
    const { hook } = setup({ status: 'succeeded', generationId: 'g', patch: PATCH });
    act(() => hook.result.current.noteClear('overview'));
    act(() => hook.result.current.noteClear('milestones'));
    vi.mocked(track).mockClear();

    act(() => hook.result.current.noteRestore('overview'));
    expect(hook.result.current).toMatchObject({ overviewDrafted: true, milestonesDrafted: false });
    act(() => hook.result.current.noteRestore('milestones'));
    expect(hook.result.current).toMatchObject({ overviewDrafted: true, milestonesDrafted: true });
    expect(track).not.toHaveBeenCalled();
  });

  it('stops polling on unmount', async () => {
    mockPoll.mockResolvedValue({ status: 'pending', generationId: 'gen-1' });
    const { hook } = setup({ status: 'pending', generationId: 'gen-1' });
    await tick();
    hook.unmount();
    await tick(PROPOSAL_DRAFT_POLL_INTERVAL_MS * 3);
    expect(mockPoll).toHaveBeenCalledTimes(1);
  });
});
