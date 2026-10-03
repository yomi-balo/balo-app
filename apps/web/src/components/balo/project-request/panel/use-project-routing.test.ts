import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { track, PROJECT_EVENTS, type ProjectStep } from '@/lib/analytics';
import type { ProjectRouting } from './send-to-selector';
import { useProjectRouting } from './use-project-routing';

const EXPERT_ID = '99999999-9999-9999-9999-999999999999';

interface HookProps {
  open: boolean;
  step: ProjectStep;
  routing: ProjectRouting;
  expertProfileId: string | undefined;
  expertAvailableForWork: boolean | undefined;
}

const BASE: HookProps = {
  open: true,
  step: 'manual',
  routing: 'direct',
  expertProfileId: EXPERT_ID,
  expertAvailableForWork: true,
};

function setup(initial: Partial<HookProps> = {}): ReturnType<
  typeof renderHook<ReturnType<typeof useProjectRouting>, HookProps>
> & {
  setRouting: ReturnType<typeof vi.fn>;
} {
  const setRouting = vi.fn();
  const rendered = renderHook(
    (props: HookProps) => useProjectRouting({ ...props, entryPoint: 'profile', setRouting }),
    { initialProps: { ...BASE, ...initial } }
  );
  return { ...rendered, setRouting };
}

function unavailableCalls(): unknown[][] {
  return vi
    .mocked(track)
    .mock.calls.filter(([event]) => event === PROJECT_EVENTS.PROJECT_EXPERT_UNAVAILABLE_SHOWN);
}

describe('useProjectRouting — changeRouting', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
  });

  it('is a no-op when the routing would not change', () => {
    const { result, setRouting } = setup({ routing: 'direct' });
    act(() => result.current.changeRouting('direct'));
    expect(setRouting).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('is a no-op on a context-free mount (no expert)', () => {
    const { result, setRouting } = setup({ expertProfileId: undefined, routing: 'match' });
    act(() => result.current.changeRouting('direct'));
    expect(setRouting).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it('sets the routing and tracks direct → match with the exact payload', () => {
    const { result, setRouting } = setup({ routing: 'direct' });
    act(() => result.current.changeRouting('match'));
    expect(setRouting).toHaveBeenCalledWith('match');
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_ROUTING_SWITCHED, {
      from: 'direct',
      to: 'match',
      entry_point: 'profile',
      expert_id: EXPERT_ID,
    });
  });

  it('tracks match → direct with the exact payload', () => {
    const { result, setRouting } = setup({ routing: 'match' });
    act(() => result.current.changeRouting('direct'));
    expect(setRouting).toHaveBeenCalledWith('direct');
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_ROUTING_SWITCHED, {
      from: 'match',
      to: 'direct',
      entry_point: 'profile',
      expert_id: EXPERT_ID,
    });
  });
});

describe('useProjectRouting — directBlocked', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
  });

  it.each<[string, Partial<HookProps>, boolean]>([
    ['unavailable expert on direct', { expertAvailableForWork: false }, true],
    ['unavailable expert on match', { expertAvailableForWork: false, routing: 'match' }, false],
    ['available expert on direct', { expertAvailableForWork: true }, false],
    ['availability unknown', { expertAvailableForWork: undefined }, false],
    [
      'no expert bound',
      { expertProfileId: undefined, expertAvailableForWork: false, routing: 'direct' },
      false,
    ],
  ])('%s', (_label, overrides, expected) => {
    const { result } = setup(overrides);
    expect(result.current.directBlocked).toBe(expected);
  });
});

describe('useProjectRouting — expert unavailable event', () => {
  beforeEach(() => {
    vi.mocked(track).mockClear();
  });

  it('fires once with the exact payload when the notice first shows on manual', () => {
    setup({ expertAvailableForWork: false });
    expect(unavailableCalls()).toHaveLength(1);
    expect(track).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_EXPERT_UNAVAILABLE_SHOWN, {
      expert_id: EXPERT_ID,
      entry_point: 'profile',
    });
  });

  it('fires once across a manual → review rerender', () => {
    const { rerender } = setup({ expertAvailableForWork: false, step: 'manual' });
    rerender({ ...BASE, expertAvailableForWork: false, step: 'review' });
    expect(unavailableCalls()).toHaveLength(1);
  });

  it('fires once across a close / reopen', () => {
    const { rerender } = setup({ expertAvailableForWork: false });
    rerender({ ...BASE, expertAvailableForWork: false, open: false });
    rerender({ ...BASE, expertAvailableForWork: false, open: true });
    expect(unavailableCalls()).toHaveLength(1);
  });

  it('fires once across a toggle away and back', () => {
    const { rerender } = setup({ expertAvailableForWork: false });
    rerender({ ...BASE, expertAvailableForWork: false, routing: 'match' });
    rerender({ ...BASE, expertAvailableForWork: false, routing: 'direct' });
    expect(unavailableCalls()).toHaveLength(1);
  });

  it('fires when the review step is reached directly', () => {
    setup({ expertAvailableForWork: false, step: 'review' });
    expect(unavailableCalls()).toHaveLength(1);
  });

  it.each<[string, Partial<HookProps>]>([
    ['on the start step', { expertAvailableForWork: false, step: 'start' }],
    ['when the panel is closed', { expertAvailableForWork: false, open: false }],
    ['when the expert is available', { expertAvailableForWork: true }],
    ['on match routing', { expertAvailableForWork: false, routing: 'match' }],
    ['with no expert bound', { expertProfileId: undefined, expertAvailableForWork: false }],
  ])('never fires %s', (_label, overrides) => {
    setup(overrides);
    expect(unavailableCalls()).toHaveLength(0);
  });
});
