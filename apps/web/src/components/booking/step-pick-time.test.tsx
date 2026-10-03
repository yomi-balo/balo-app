import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/analytics', () => ({
  track: vi.fn(),
  AVAILABILITY_EVENTS: {},
}));

import { StepPickTime } from './step-pick-time';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ expertProfileId: 'e1', status: 'paused', days: 14 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderStep(similarExpertsHref?: string): void {
  render(
    <StepPickTime
      expertProfileId="e1"
      expertFirstName="Priya"
      onSlotSelect={vi.fn()}
      onMessage={vi.fn()}
      similarExpertsHref={similarExpertsHref}
    />
  );
}

describe('StepPickTime paused state', () => {
  it('offers "Find a similar expert" first and keeps the message escape', async () => {
    renderStep('/experts?vertical=salesforce');
    const link = await screen.findByRole('link', { name: /find a similar expert/i });
    expect(link).toHaveAttribute('href', '/experts?vertical=salesforce');
    expect(screen.getByRole('button', { name: /message priya instead/i })).toBeInTheDocument();
  });

  it('shows only the message escape when no search link is known', async () => {
    renderStep();
    expect(
      await screen.findByRole('button', { name: /message priya instead/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /find a similar expert/i })).not.toBeInTheDocument();
  });
});
