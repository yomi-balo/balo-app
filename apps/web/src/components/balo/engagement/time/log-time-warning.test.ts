import { describe, it, expect } from 'vitest';

import { logTimeWarning } from './log-time-warning';

const base = {
  milestoneTitle: 'Build',
  estimatedMinutes: 480,
  loggedMinutes: 420,
  replacedMinutes: 0,
  addMinutes: 30,
  clientCompanyName: 'Northwind',
};

describe('logTimeWarning', () => {
  it('is null while the new total stays within the estimate', () => {
    expect(logTimeWarning(base)).toBeNull();
    expect(logTimeWarning({ ...base, addMinutes: 60 })).toBeNull();
  });

  it('is null without an estimate or without hours', () => {
    expect(logTimeWarning({ ...base, estimatedMinutes: null })).toBeNull();
    expect(logTimeWarning({ ...base, addMinutes: 0 })).toBeNull();
  });

  it('says how far over this entry takes the milestone, and that the client is told', () => {
    expect(logTimeWarning({ ...base, addMinutes: 120 })).toBe(
      'This takes Build 1 hr over its 8 hrs estimate. Northwind will be notified.'
    );
  });

  it('says the milestone is already over when it was past the estimate before', () => {
    expect(logTimeWarning({ ...base, loggedMinutes: 540, addMinutes: 60 })).toBe(
      'Build is already over its 8 hrs estimate. This takes it to 10 hrs.'
    );
  });

  it('leaves the edited entry out of the before total', () => {
    expect(
      logTimeWarning({ ...base, loggedMinutes: 540, replacedMinutes: 120, addMinutes: 60 })
    ).toBeNull();
    expect(
      logTimeWarning({ ...base, loggedMinutes: 540, replacedMinutes: 120, addMinutes: 150 })
    ).toBe('This takes Build 1.5 hrs over its 8 hrs estimate. Northwind will be notified.');
  });

  it('treats an estimate of zero as crossed by the first entry', () => {
    expect(logTimeWarning({ ...base, estimatedMinutes: 0, loggedMinutes: 0, addMinutes: 15 })).toBe(
      'This takes Build 0.25 hrs over its 0 hrs estimate. Northwind will be notified.'
    );
  });
});
