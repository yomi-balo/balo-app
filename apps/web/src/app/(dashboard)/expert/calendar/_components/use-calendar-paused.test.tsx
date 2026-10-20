import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AvailabilityView } from '@/components/availability/use-expert-availability';
import { useCalendarPaused } from './use-calendar-paused';

const PAUSED: AvailabilityView = { kind: 'paused' };
const LOADING: AvailabilityView = { kind: 'loading' };

interface Props {
  availableForWork: boolean;
  view: AvailabilityView | null;
  serverRender: object;
}

function setup(initial: Props) {
  return renderHook(
    ({ availableForWork, view, serverRender }: Props) =>
      useCalendarPaused(availableForWork, view, serverRender),
    { initialProps: initial }
  );
}

describe('useCalendarPaused', () => {
  it('is paused whenever the server render says the expert is not available', () => {
    const { result } = setup({ availableForWork: false, view: null, serverRender: {} });
    expect(result.current).toBe(true);
  });

  it('is not paused when the server render says available and no paused answer arrived', () => {
    const { result } = setup({ availableForWork: true, view: LOADING, serverRender: {} });
    expect(result.current).toBe(false);
  });

  it('latches a paused answer and holds it after the follow-up read stops answering paused', () => {
    const render1 = {};
    const { result, rerender } = setup({
      availableForWork: true,
      view: PAUSED,
      serverRender: render1,
    });
    expect(result.current).toBe(true);

    rerender({ availableForWork: true, view: LOADING, serverRender: render1 });
    expect(result.current).toBe(true);
  });

  it('releases the latch on a new server render even when availableForWork reads true both times', () => {
    const { result, rerender } = setup({ availableForWork: true, view: PAUSED, serverRender: {} });
    expect(result.current).toBe(true);

    rerender({ availableForWork: true, view: LOADING, serverRender: {} });
    expect(result.current).toBe(false);
  });

  it('releases the latch after a false-then-true round trip of the server value', () => {
    const { result, rerender } = setup({ availableForWork: true, view: PAUSED, serverRender: {} });
    rerender({ availableForWork: false, view: LOADING, serverRender: {} });
    expect(result.current).toBe(true);

    rerender({ availableForWork: true, view: LOADING, serverRender: {} });
    expect(result.current).toBe(false);
  });
});
