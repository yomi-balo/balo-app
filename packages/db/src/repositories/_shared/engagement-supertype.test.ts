import { describe, it, expect } from 'vitest';
import {
  projectDeliveryToEngagementStatus,
  type ProjectDeliveryStatus,
  type EngagementStatus,
} from './engagement-supertype';

/**
 * The ONE projection point (BAL-417 / §1.6.1), pure and DB-free. Every writer that
 * changes `project_engagements.delivery_status` must write `engagements.status` from
 * this function in the same transaction, so this table IS the contract that keeps the
 * two columns from drifting (R5).
 */
describe('projectDeliveryToEngagementStatus', () => {
  const cases: Array<[ProjectDeliveryStatus, EngagementStatus]> = [
    ['active', 'active'],
    // THE LOSSY ARM, and the reason `lockActiveEngagement` re-reads the child: a
    // project awaiting client acceptance is `'active'` on the parent but is NOT mutable.
    ['pending_acceptance', 'active'],
    ['completed', 'completed'],
    ['cancelled', 'cancelled'],
  ];

  for (const [delivery, expected] of cases) {
    it(`maps ${delivery} → ${expected}`, () => {
      expect(projectDeliveryToEngagementStatus(delivery)).toBe(expected);
    });
  }

  it('is exhaustive over the four delivery labels', () => {
    expect(cases).toHaveLength(4);
    expect(new Set(cases.map(([d]) => d)).size).toBe(4);
  });
});
