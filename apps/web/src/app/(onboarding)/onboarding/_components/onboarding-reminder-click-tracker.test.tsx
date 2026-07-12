import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@/test/utils';
import { track, ONBOARDING_REMINDER_EVENTS } from '@/lib/analytics';
import { OnboardingReminderClickTracker } from './onboarding-reminder-click-tracker';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OnboardingReminderClickTracker (BAL-374)', () => {
  it('fires onboarding_reminder_clicked once on mount with the step + domain class', () => {
    render(<OnboardingReminderClickTracker cadenceStep={2} domainClass="corporate" />);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith(ONBOARDING_REMINDER_EVENTS.CLICKED, {
      cadence_step: 2,
      domain_class: 'corporate',
    });
  });

  it('renders nothing (pure analytics island)', () => {
    const { container } = render(
      <OnboardingReminderClickTracker cadenceStep={1} domainClass="freemail" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('does not double-fire on re-render (ref-guarded, once per mount)', () => {
    const { rerender } = render(
      <OnboardingReminderClickTracker cadenceStep={1} domainClass="freemail" />
    );
    rerender(<OnboardingReminderClickTracker cadenceStep={1} domainClass="freemail" />);

    expect(track).toHaveBeenCalledTimes(1);
  });
});
