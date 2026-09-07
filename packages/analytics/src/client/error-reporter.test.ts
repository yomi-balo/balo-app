import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  reportAnalyticsError,
  setAnalyticsErrorReporter,
  type AnalyticsErrorReporter,
} from './error-reporter';

describe('reportAnalyticsError / setAnalyticsErrorReporter', () => {
  afterEach(() => {
    // Every test must leave the module-level singleton clean for the next one.
    setAnalyticsErrorReporter(null);
  });

  it('is a no-op with no reporter installed', () => {
    expect(() => reportAnalyticsError(new Error('boom'), 'track')).not.toThrow();
  });

  it('routes error + method to the installed reporter', () => {
    const reporter = vi.fn<AnalyticsErrorReporter>();
    setAnalyticsErrorReporter(reporter);
    const error = new Error('capture failed');

    reportAnalyticsError(error, 'identify');

    expect(reporter).toHaveBeenCalledWith(error, { method: 'identify' });
  });

  it('a reporter that ITSELF throws does not escape', () => {
    const throwingReporter: AnalyticsErrorReporter = () => {
      throw new Error('reporter is also broken');
    };
    setAnalyticsErrorReporter(throwingReporter);

    expect(() => reportAnalyticsError(new Error('original'), 'page')).not.toThrow();
  });

  it('setAnalyticsErrorReporter(null) uninstalls', () => {
    const reporter = vi.fn<AnalyticsErrorReporter>();
    setAnalyticsErrorReporter(reporter);
    setAnalyticsErrorReporter(null);

    reportAnalyticsError(new Error('after uninstall'), 'reset');

    expect(reporter).not.toHaveBeenCalled();
  });
});
