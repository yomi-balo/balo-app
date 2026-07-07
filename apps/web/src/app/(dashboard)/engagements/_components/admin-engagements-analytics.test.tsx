import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@/test/utils';
import { track, ADMIN_ENGAGEMENTS_EVENTS } from '@/lib/analytics';
import type { OversightCounts } from '@/lib/engagements/oversight-row';
import { AdminEngagementsAnalytics } from './admin-engagements-analytics';

const trackMock = vi.mocked(track);

function counts(overrides: Partial<OversightCounts> = {}): OversightCounts {
  return { active: 3, inReview: 2, stalled: 1, completed: 4, cancelled: 1, ...overrides };
}

describe('AdminEngagementsAnalytics', () => {
  beforeEach(() => {
    trackMock.mockClear();
  });

  it('fires list_viewed on mount with the filter + mapped counts', () => {
    render(<AdminEngagementsAnalytics filter="in_flight" counts={counts()} />);
    expect(trackMock).toHaveBeenCalledWith(ADMIN_ENGAGEMENTS_EVENTS.LIST_VIEWED, {
      filter: 'in_flight',
      count_active: 3,
      count_in_review: 2,
      count_stalled: 1,
    });
  });

  it('fires once per filter (a same-filter re-render does not re-fire)', () => {
    const { rerender } = render(<AdminEngagementsAnalytics filter="stalled" counts={counts()} />);
    rerender(<AdminEngagementsAnalytics filter="stalled" counts={counts()} />);
    expect(trackMock).toHaveBeenCalledTimes(1);
  });

  it('re-fires with the new filter when the filter changes', () => {
    const { rerender } = render(<AdminEngagementsAnalytics filter="in_flight" counts={counts()} />);
    rerender(<AdminEngagementsAnalytics filter="completed" counts={counts()} />);
    expect(trackMock).toHaveBeenCalledTimes(2);
    expect(trackMock).toHaveBeenLastCalledWith(ADMIN_ENGAGEMENTS_EVENTS.LIST_VIEWED, {
      filter: 'completed',
      count_active: 3,
      count_in_review: 2,
      count_stalled: 1,
    });
  });
});
