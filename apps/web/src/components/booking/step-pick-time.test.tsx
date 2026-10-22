import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/analytics', () => ({
  track: vi.fn(),
  AVAILABILITY_EVENTS: {},
}));

import { StepPickTime, pickerRestoreFor } from './step-pick-time';

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

describe('pickerRestoreFor', () => {
  const slot = {
    startIso: '2026-06-05T09:00:00.000Z',
    endIso: '2026-06-05T09:45:00.000Z',
    durationMinutes: 45 as const,
  };

  it('restores the whole choice for a live slot', () => {
    expect(pickerRestoreFor(slot, false)).toEqual({
      initialSelection: { start: slot.startIso, end: slot.endIso, duration: 45 },
    });
  });

  it('carries only the length for a stale slot', () => {
    expect(pickerRestoreFor(slot, true)).toEqual({ initialDurationMinutes: 45 });
  });

  it('has nothing to restore without a slot', () => {
    expect(pickerRestoreFor(null, false)).toBeNull();
  });
});

describe('StepPickTime forwards the picker props', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          expertProfileId: 'e1',
          status: 'ok',
          expertTimezone: 'UTC',
          generatedAt: '2026-06-01T00:00:00.000Z',
          windowEnd: '2026-06-15T00:00:00.000Z',
          days: 14,
          slots: [
            { start: '2099-06-05T09:00:00.000Z', end: '2099-06-05T10:00:00.000Z', maxDuration: 60 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
  });

  it('renders the length note and honours defaultDurationMinutes', async () => {
    render(
      <StepPickTime
        expertProfileId="e1"
        expertFirstName="Priya"
        onSlotSelect={vi.fn()}
        onMessage={vi.fn()}
        lengthNote={<p>Billing note</p>}
        defaultDurationMinutes={30}
      />
    );

    expect(await screen.findByText('Billing note')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '30 min' })).toBeChecked();
  });

  it('restores a previous length from initialDurationMinutes without a time', async () => {
    render(
      <StepPickTime
        expertProfileId="e1"
        expertFirstName="Priya"
        onSlotSelect={vi.fn()}
        onMessage={vi.fn()}
        initialDurationMinutes={30}
      />
    );

    expect(await screen.findByRole('radio', { name: '30 min' })).toBeChecked();
  });

  it('restores the day from initialSelection', async () => {
    render(
      <StepPickTime
        expertProfileId="e1"
        expertFirstName="Priya"
        onSlotSelect={vi.fn()}
        onMessage={vi.fn()}
        initialSelection={{
          start: '2099-06-05T09:00:00.000Z',
          end: '2099-06-05T10:00:00.000Z',
          duration: 60,
        }}
      />
    );

    expect(await screen.findByRole('button', { name: /^9:00 – 10:00 am/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });
});
