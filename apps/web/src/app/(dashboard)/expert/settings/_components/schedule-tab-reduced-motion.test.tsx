import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useReducedMotion } from 'motion/react';
import { ScheduleTab } from './schedule-tab';

/**
 * Real `motion/react`: `?tab=schedule` server-renders the tab's loading state, and
 * `useReducedMotion()` is null on the server and true on the client, so the motion root's inline
 * `initial` style must not depend on it.
 */
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./calendar-connections-section', () => ({
  CalendarConnectionsSection: () => <div />,
}));
vi.mock('./date-overrides-card', () => ({ DateOverridesCard: () => <div /> }));
vi.mock('../_actions/get-schedule', () => ({ getScheduleAction: vi.fn() }));
vi.mock('../_actions/save-schedule', () => ({ saveScheduleAction: vi.fn() }));
vi.mock('../_actions/clear-schedule', () => ({ clearScheduleAction: vi.fn() }));
vi.mock('../_actions/update-schedule-timezone', () => ({ updateScheduleTimezoneAction: vi.fn() }));
vi.mock('../_actions/set-work-availability', () => ({ setWorkAvailabilityAction: vi.fn() }));

describe('ScheduleTab reduced motion', () => {
  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const unresolved = renderToStaticMarkup(<ScheduleTab />);
    vi.mocked(useReducedMotion).mockReturnValue(true);
    expect(renderToStaticMarkup(<ScheduleTab />)).toBe(unresolved);
    expect(unresolved).toContain('opacity:0');
  });
});
