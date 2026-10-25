import { describe, it, expect } from 'vitest';
import { buildRepeatChangeRequestAlertDetail } from './repeat-change-request-alert';

const BASE = {
  projectTitle: 'CPQ implementation',
  clientCompanyName: 'Northwind Industrial',
  actorClientLabel: 'Dana @ Northwind Industrial',
  expertLabel: 'CloudPeak Consulting',
  roundNumber: 2,
  taggedMilestoneTitles: ['Discovery', 'Build'],
  requestedOn: '6 Jul',
};

describe('buildRepeatChangeRequestAlertDetail', () => {
  it('builds the title, entity label and evidence sentence', () => {
    const detail = buildRepeatChangeRequestAlertDetail(BASE);
    expect(detail.title).toBe('Changes requested again on CPQ implementation');
    expect(detail.entityLabel).toBe('CPQ implementation · Northwind Industrial');
    expect(detail.evidence).toBe(
      'Dana @ Northwind Industrial sent it back to CloudPeak Consulting for round 2 on 6 Jul.'
    );
  });

  it('lists the round, parties and tagged milestones as facts', () => {
    expect(buildRepeatChangeRequestAlertDetail(BASE).facts).toEqual([
      ['Round', '2'],
      ['Client', 'Northwind Industrial'],
      ['Expert', 'CloudPeak Consulting'],
      ['Tagged milestones', 'Discovery and Build'],
    ]);
  });

  it('reads "None" for an untagged round', () => {
    const detail = buildRepeatChangeRequestAlertDetail({ ...BASE, taggedMilestoneTitles: [] });
    expect(detail.facts).toContainEqual(['Tagged milestones', 'None']);
  });
});
