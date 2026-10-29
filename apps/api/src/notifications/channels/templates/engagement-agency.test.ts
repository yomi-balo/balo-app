import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { EngagementCancelledAgencyEmail } from './engagement-cancelled-agency.js';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

const BASE = 'https://app.balo.expert';

const fullData = {
  engagementId: 'eng-1',
  projectTitle: 'CPQ implementation',
  cancelledOn: '12 Nov',
  clientCompanyName: 'Northwind Industrial',
  deliveringExpertName: 'Priya Shah',
  deliveringAgencyName: 'Cloudline Partners',
  actorLabel: 'MJ Okonkwo @ Balo',
  recipientName: 'Sam',
};

const emailProps = {
  firstName: 'Sam',
  projectTitle: 'CPQ implementation',
  cancelledOn: '12 Nov',
  engagementId: 'eng-1',
  baseUrl: BASE,
};

describe('EngagementCancelledAgencyEmail (BAL-631)', () => {
  it('renders the full copy, the trimmed line 3 and the ?from=agency CTA', async () => {
    const html = await render(
      EngagementCancelledAgencyEmail({
        ...emailProps,
        deliveringExpertName: 'Priya Shah',
        deliveringAgencyName: 'Cloudline Partners',
        clientCompanyName: 'Northwind Industrial',
        actorLabel: 'MJ Okonkwo @ Balo',
      })
    );
    expect(html).toContain('Delivered by Priya Shah at Cloudline Partners.');
    expect(html).toContain('Hi ');
    expect(html).toContain('Sam');
    expect(html).toContain(
      '&#x27;CPQ implementation&#x27;, the project Priya Shah was delivering for Northwind Industrial, was cancelled on 12 Nov. It was cancelled by MJ Okonkwo @ Balo.'
    );
    expect(html).toContain(
      'Nothing more is needed from Cloudline Partners unless you&#x27;d like to follow up with the team.'
    );
    expect(html).toContain('View the project');
    expect(html).toContain(`${BASE}/engagements/eng-1?from=agency`);
    expect(html).not.toContain('invoice');
  });

  it('drops every optional clause when the fields are absent', async () => {
    const html = await render(EngagementCancelledAgencyEmail(emailProps));
    expect(html).toContain('was cancelled on 12 Nov.');
    expect(html).not.toContain('was delivering');
    expect(html).not.toContain('It was cancelled by');
    expect(html).not.toContain('Delivered by');
    expect(html).toContain('Nothing more is needed from your agency');
  });

  it.each([
    [
      'client and deliverer',
      { clientCompanyName: 'Northwind Industrial', deliveringExpertName: 'Priya Shah' },
      ', the project Priya Shah was delivering for Northwind Industrial, was cancelled on 12 Nov.',
    ],
    [
      'client only',
      { clientCompanyName: 'Northwind Industrial' },
      ' for Northwind Industrial was cancelled on 12 Nov.',
    ],
    [
      'deliverer only',
      { deliveringExpertName: 'Priya Shah' },
      ', the project Priya Shah was delivering, was cancelled on 12 Nov.',
    ],
    ['neither', {}, ' was cancelled on 12 Nov.'],
  ])('joins the clauses cleanly with %s', async (_label, extra, expected) => {
    const html = await render(EngagementCancelledAgencyEmail({ ...emailProps, ...extra }));
    expect(html).toContain(`CPQ implementation&#x27;${expected}`);
  });
});

describe('engagement-cancelled-agency email registry entry (BAL-631)', () => {
  it('builds the subject with the client when present', () => {
    const template = getEmailTemplate('engagement-cancelled-agency', fullData);
    expect(template?.subject).toBe(
      'CPQ implementation for Northwind Industrial has been cancelled'
    );
  });

  it('builds the subject without a client', () => {
    const { clientCompanyName: _omit, ...rest } = fullData;
    const template = getEmailTemplate('engagement-cancelled-agency', rest);
    expect(template?.subject).toBe('CPQ implementation has been cancelled');
  });

  it('treats a blank client as absent', () => {
    const template = getEmailTemplate('engagement-cancelled-agency', {
      ...fullData,
      clientCompanyName: '   ',
    });
    expect(template?.subject).toBe('CPQ implementation has been cancelled');
  });
});

describe('agency in-app templates (BAL-631)', () => {
  const inApp = (name: string, data: Record<string, unknown>) => getInAppTemplate(name, data);

  it('changes requested: names the client label and the deliverer, links with ?from=agency', () => {
    const out = inApp('engagement-changes-requested-agency', {
      engagementId: 'eng-1',
      actorClientLabel: 'Dana @ Northwind Industrial',
      projectTitle: 'CPQ implementation',
      deliveringExpertName: 'Priya Shah',
    });
    expect(out?.title).toBe('Changes requested');
    expect(out?.body).toBe(
      "Dana @ Northwind Industrial requested changes on 'CPQ implementation', delivered by Priya Shah. Open the project to see what's needed."
    );
    expect(out?.actionUrl).toBe('/engagements/eng-1?from=agency');
  });

  it('changes requested: drops the deliverer clause when absent', () => {
    const out = inApp('engagement-changes-requested-agency', {
      engagementId: 'eng-1',
      actorClientLabel: 'Dana @ Northwind Industrial',
      projectTitle: 'CPQ implementation',
    });
    expect(out?.body).toBe(
      "Dana @ Northwind Industrial requested changes on 'CPQ implementation'. Open the project to see what's needed."
    );
  });

  it('milestone over estimate: states the hours and who is delivering', () => {
    const out = inApp('engagement-milestone-estimate-exceeded-agency', {
      engagementId: 'eng-1',
      projectTitle: 'CPQ implementation',
      milestoneTitle: 'Data migration',
      loggedHoursLabel: '14 hrs',
      estimatedHoursLabel: '10 hrs',
      deliveringExpertName: 'Priya Shah',
    });
    expect(out?.title).toBe('Milestone over estimate');
    expect(out?.body).toBe(
      "'Data migration' on 'CPQ implementation' is at 14 hrs; the estimate is 10 hrs. Priya Shah is delivering."
    );
    expect(out?.actionUrl).toBe('/engagements/eng-1?from=agency');
  });

  it('milestone over estimate: drops the deliverer sentence when absent', () => {
    const out = inApp('engagement-milestone-estimate-exceeded-agency', {
      engagementId: 'eng-1',
      projectTitle: 'CPQ implementation',
      milestoneTitle: 'Data migration',
      loggedHoursLabel: '14 hrs',
      estimatedHoursLabel: '10 hrs',
    });
    expect(out?.body).toBe(
      "'Data migration' on 'CPQ implementation' is at 14 hrs; the estimate is 10 hrs."
    );
  });

  it('cancelled: full copy with the actor', () => {
    const out = inApp('engagement-cancelled-agency', fullData);
    expect(out?.title).toBe('Project cancelled');
    expect(out?.body).toBe(
      "'CPQ implementation' for Northwind Industrial, delivered by Priya Shah, was cancelled on 12 Nov. Cancelled by MJ Okonkwo @ Balo."
    );
    expect(out?.actionUrl).toBe('/engagements/eng-1?from=agency');
  });

  it('cancelled: every optional clause drops when its field is absent', () => {
    const out = inApp('engagement-cancelled-agency', {
      engagementId: 'eng-1',
      projectTitle: 'CPQ implementation',
      cancelledOn: '12 Nov',
    });
    expect(out?.body).toBe("'CPQ implementation' was cancelled on 12 Nov.");
  });

  it('has no actionUrl when the engagement id is missing', () => {
    const out = inApp('engagement-cancelled-agency', { projectTitle: 'CPQ implementation' });
    expect(out?.actionUrl).toBeUndefined();
  });
});
