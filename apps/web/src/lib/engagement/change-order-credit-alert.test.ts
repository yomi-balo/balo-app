import { describe, it, expect } from 'vitest';
import { buildChangeOrderCreditAlertDetail } from './change-order-credit-alert';

const BASE = {
  projectTitle: 'CPQ implementation',
  clientCompanyName: 'Northwind Industrial',
  approverLabel: 'Dana @ Northwind Industrial',
  expertLabel: 'CloudPeak Consulting',
  approvedOn: '6 Jul',
};

describe('buildChangeOrderCreditAlertDetail', () => {
  it('builds the title, entity label and evidence sentence', () => {
    const detail = buildChangeOrderCreditAlertDetail(BASE);
    expect(detail.title).toBe('Credit needed on CPQ implementation');
    expect(detail.entityLabel).toBe('CPQ implementation · Northwind Industrial');
    expect(detail.evidence).toBe(
      'Dana @ Northwind Industrial approved a change on 6 Jul that takes the price below what Northwind Industrial has already been invoiced. Issue an adjustment note, then close this item.'
    );
  });

  it('lists the parties and approval date as facts, with no amounts', () => {
    expect(buildChangeOrderCreditAlertDetail(BASE).facts).toEqual([
      ['Client', 'Northwind Industrial'],
      ['Expert', 'CloudPeak Consulting'],
      ['Approved', '6 Jul'],
    ]);
  });
});
