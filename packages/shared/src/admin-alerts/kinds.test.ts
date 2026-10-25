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

describe('ADMIN_ALERT_KINDS — change-order kinds (BAL-622)', () => {
  it.each(['project.change_order_stale', 'project.change_order_credit_required'] as const)(
    '%s targets the project page',
    (kind) => {
      expect(ADMIN_ALERT_KINDS[kind].target({ entityId: 'eng_1', detail: DETAIL })).toEqual({
        label: 'the project',
        href: '/engagements/eng_1',
      });
    }
  );

  it('the stale kind is a 15m marketplace finder kind', () => {
    const meta = ADMIN_ALERT_KINDS['project.change_order_stale'];
    expect(meta).toMatchObject({
      group: 'marketplace',
      finder: 'projectChangeOrderStale',
      cadence: '15m',
    });
  });

  it('the credit kind is an event-driven money kind', () => {
    const meta = ADMIN_ALERT_KINDS['project.change_order_credit_required'];
    expect(meta).toMatchObject({ group: 'money', finder: null, cadence: null });
  });
});
