import { describe, it, expect } from 'vitest';
import { ADMIN_ALERT_KINDS } from './kinds';
import type { AdminAlertDetail } from './detail';

const DETAIL: AdminAlertDetail = {
  title: 'An expert application is waiting for review',
  entityLabel: 'Priya Nair',
  evidence: 'Submitted 6 days ago',
  facts: [],
};

describe('ADMIN_ALERT_KINDS — expert.application_pending target (BAL-549)', () => {
  it('targets the id-keyed application review page', () => {
    expect(
      ADMIN_ALERT_KINDS['expert.application_pending'].target({
        entityId: 'a1b2c3',
        detail: DETAIL,
      })
    ).toEqual({ label: 'the application', href: '/admin/applications/a1b2c3' });
  });

  it('never falls back to the admin catalogue', () => {
    const target = ADMIN_ALERT_KINDS['expert.application_pending'].target({
      entityId: 'a1b2c3',
      detail: DETAIL,
    });
    expect(target.href).not.toBe('/admin/catalogue');
  });
});
