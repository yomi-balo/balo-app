import { describe, expect, it } from 'vitest';
import { planProjectTermsPublish } from './project-terms-publish';

const V1 = { version: '2025-07-23', sha256: 'aaa' };
const V2 = { version: '2026-03-01', sha256: 'bbb' };

describe('planProjectTermsPublish', () => {
  it('appends the first version to an empty list', () => {
    expect(planProjectTermsPublish(V1, [])).toEqual({ kind: 'append', entry: V1 });
  });

  it('appends a later version', () => {
    expect(planProjectTermsPublish(V2, [V1])).toEqual({ kind: 'append', entry: V2 });
  });

  it('is up to date when the listed hash matches', () => {
    expect(planProjectTermsPublish(V1, [V1])).toEqual({ kind: 'up_to_date' });
    expect(planProjectTermsPublish(V1, [V1, V2])).toEqual({ kind: 'up_to_date' });
  });

  it('refuses a listed version whose text changed', () => {
    const plan = planProjectTermsPublish({ ...V1, sha256: 'changed' }, [V1]);
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.reason).toContain('set a new PROJECT_TERMS_VERSION');
  });

  it('refuses an unlisted version that is not later than the last one', () => {
    const plan = planProjectTermsPublish({ version: '2025-12-01', sha256: 'ccc' }, [V1, V2]);
    expect(plan.kind).toBe('refuse');
    expect(plan.kind === 'refuse' && plan.reason).toContain('not later than');
  });
});
