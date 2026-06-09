import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, cleanup } from '@/test/utils';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { RequestDetailAnalytics } from './request-detail-analytics';

const trackMock = vi.mocked(track);

describe('RequestDetailAnalytics', () => {
  beforeEach(() => {
    trackMock.mockClear();
    window.sessionStorage.clear();
  });

  it('fires detail_viewed on mount with the lens context', () => {
    render(
      <RequestDetailAnalytics
        requestId="req-1"
        lens="expert"
        archetype="participant"
        status="eoi_submitted"
        phase="phase2"
      />
    );
    expect(trackMock).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_DETAIL_VIEWED, {
      request_id: 'req-1',
      lens: 'expert',
      archetype: 'participant',
      status: 'eoi_submitted',
      phase: 'phase2',
    });
  });

  it('fires phase_flipped once for the first Phase-2 view per (request, lens)', () => {
    render(
      <RequestDetailAnalytics
        requestId="req-1"
        lens="client"
        archetype="participant"
        status="eoi_submitted"
        phase="phase2"
      />
    );
    expect(trackMock).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_REQUEST_PHASE_FLIPPED, {
      request_id: 'req-1',
      lens: 'client',
      from_phase: 'phase1',
      to_phase: 'phase2',
    });

    // A re-mount with the same (request, lens) must NOT re-fire (sessionStorage guard).
    cleanup();
    trackMock.mockClear();
    render(
      <RequestDetailAnalytics
        requestId="req-1"
        lens="client"
        archetype="participant"
        status="proposal_submitted"
        phase="phase2"
      />
    );
    expect(trackMock).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_REQUEST_PHASE_FLIPPED,
      expect.anything()
    );
  });

  it('fires phase_flipped at most once per mount when sessionStorage throws (private mode)', () => {
    // Simulate blocked storage (Safari private mode): both read and write throw.
    const getItemSpy = vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    const setItemSpy = vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    try {
      const { rerender } = render(
        <RequestDetailAnalytics
          requestId="req-1"
          lens="client"
          archetype="participant"
          status="eoi_submitted"
          phase="phase2"
        />
      );

      // Re-render the SAME mount several times — the per-mount ref must keep
      // phase_flipped to a single fire even though the storage guard always throws.
      rerender(
        <RequestDetailAnalytics
          requestId="req-1"
          lens="client"
          archetype="participant"
          status="proposal_submitted"
          phase="phase2"
        />
      );
      rerender(
        <RequestDetailAnalytics
          requestId="req-1"
          lens="client"
          archetype="participant"
          status="accepted"
          phase="phase2"
        />
      );

      const flipCalls = trackMock.mock.calls.filter(
        ([event]) => event === PROJECT_EVENTS.PROJECT_REQUEST_PHASE_FLIPPED
      );
      expect(flipCalls).toHaveLength(1);
    } finally {
      getItemSpy.mockRestore();
      setItemSpy.mockRestore();
    }
  });

  it('does not fire phase_flipped in Phase 1', () => {
    render(
      <RequestDetailAnalytics
        requestId="req-1"
        lens="client"
        archetype="participant"
        status="requested"
        phase="phase1"
      />
    );
    expect(trackMock).not.toHaveBeenCalledWith(
      PROJECT_EVENTS.PROJECT_REQUEST_PHASE_FLIPPED,
      expect.anything()
    );
  });

  it('fires dwell once when the tab is hidden', () => {
    render(
      <RequestDetailAnalytics
        requestId="req-1"
        lens="admin"
        archetype="observer"
        status="eoi_submitted"
        phase="phase2"
      />
    );
    trackMock.mockClear();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    const dwellCalls = trackMock.mock.calls.filter(
      ([event]) => event === PROJECT_EVENTS.PROJECT_REQUEST_DETAIL_DWELL
    );
    expect(dwellCalls).toHaveLength(1);
    const [, props] = dwellCalls[0]!;
    expect(props).toMatchObject({ request_id: 'req-1', lens: 'admin', status: 'eoi_submitted' });
    expect(typeof (props as { dwell_ms: number }).dwell_ms).toBe('number');
  });
});
