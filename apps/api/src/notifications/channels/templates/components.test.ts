import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';
import { ExpertApprovedEmail } from './expert-approved.js';
import { ExpertReferralInvitedEmail } from './expert-referral-invited.js';
import { ProjectRequestSubmittedEmail } from './project-request-submitted.js';
import { ProjectMatchRequestedEmail } from './project-match-requested.js';
import { ProjectExploratoryRequestedEmail } from './project-exploratory-requested.js';
import { ProjectExpertInvitedEmail } from './project-expert-invited.js';
import { ProjectEoiSubmittedEmail } from './project-eoi-submitted.js';
import { ProjectProposalRequestedEmail } from './project-proposal-requested.js';
import { ProjectProposalSubmittedEmail } from './project-proposal-submitted.js';
import { ProjectProposalAcceptedEmail } from './project-proposal-accepted.js';
import {
  ProjectKickoffApprovedExpertEmail,
  ProjectKickoffApprovedClientEmail,
} from './project-kickoff-approved.js';
import { ProjectProposalNotSelectedEmail } from './project-proposal-not-selected.js';
import { ProjectChangesRequestedEmail } from './project-changes-requested.js';
import { ProjectProposalResubmittedEmail } from './project-proposal-resubmitted.js';
import { getEmailTemplate, sanitizeSubjectTitle } from './index.js';
import {
  EmailShell,
  LogoRow,
  StatusPill,
  Callout,
  SupportFooter,
  pluralize,
  buildSelectionSummary,
} from './shared.js';

describe('WelcomeEmail', () => {
  it('returns a React element for client role', () => {
    const element = WelcomeEmail({
      firstName: 'Alice',
      role: 'client',
      baseUrl: 'https://app.balo.expert',
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('returns a React element for expert role', () => {
    const element = WelcomeEmail({
      firstName: 'Bob',
      role: 'expert',
      baseUrl: 'https://app.balo.expert',
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ApplicationSubmittedEmail', () => {
  it('returns a React element', () => {
    const element = ApplicationSubmittedEmail({
      firstName: 'Carol',
      baseUrl: 'https://app.balo.expert',
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ExpertApprovedEmail', () => {
  it('returns a React element', () => {
    const element = ExpertApprovedEmail({
      firstName: 'Dave',
      baseUrl: 'https://app.balo.expert',
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ExpertReferralInvitedEmail', () => {
  it('returns a React element', () => {
    const element = ExpertReferralInvitedEmail({
      inviterName: 'Ada Lovelace',
      applyUrl: 'https://app.balo.expert/expert/apply',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('renders the inviter name and the apply CTA href, greeting generically (no recipientName)', async () => {
    const html = await render(
      ExpertReferralInvitedEmail({
        inviterName: 'Ada Lovelace',
        applyUrl: 'https://app.balo.expert/expert/apply',
      })
    );
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('https://app.balo.expert/expert/apply');
    expect(html).toContain('Hi there,');
  });
});

describe('ProjectRequestSubmittedEmail', () => {
  it('returns a React element', () => {
    const element = ProjectRequestSubmittedEmail({
      firstName: 'Erin',
      projectTitle: 'Lead routing rebuild',
      baseUrl: 'https://app.balo.expert',
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('returns a React element with selection counts', () => {
    const element = ProjectRequestSubmittedEmail({
      firstName: 'Erin',
      projectTitle: 'Lead routing rebuild',
      baseUrl: 'https://app.balo.expert',
      tagCount: 3,
      productCount: 2,
      documentCount: 1,
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ProjectMatchRequestedEmail', () => {
  it('returns a React element', () => {
    const element = ProjectMatchRequestedEmail({
      projectTitle: 'Lead routing rebuild',
      companyName: 'Acme Inc',
      baseUrl: 'https://app.balo.expert',
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('returns a React element with counts and default company name', () => {
    const element = ProjectMatchRequestedEmail({
      projectTitle: 'Lead routing rebuild',
      companyName: 'A client',
      baseUrl: 'https://app.balo.expert',
      tagCount: 2,
      productCount: 0,
      documentCount: 4,
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ProjectExploratoryRequestedEmail', () => {
  it('returns a React element', () => {
    const element = ProjectExploratoryRequestedEmail({
      firstName: 'Dana',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ProjectExpertInvitedEmail', () => {
  it('returns a React element', () => {
    const element = ProjectExpertInvitedEmail({
      firstName: 'Priya',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ProjectEoiSubmittedEmail', () => {
  it('returns a React element', () => {
    const element = ProjectEoiSubmittedEmail({
      firstName: 'Dana',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      expertName: 'Priya Nair',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ProjectProposalRequestedEmail', () => {
  it('returns a React element', () => {
    const element = ProjectProposalRequestedEmail({
      firstName: 'Priya',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ProjectProposalSubmittedEmail', () => {
  it('returns a React element carrying the expert name', () => {
    const element = ProjectProposalSubmittedEmail({
      firstName: 'Dana',
      expertName: 'Priya Nair',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('renders the expert name, review CTA, and a link to the request', async () => {
    const html = await render(
      ProjectProposalSubmittedEmail({
        firstName: 'Dana',
        expertName: 'Priya Nair',
        projectTitle: 'CPQ implementation',
        projectRequestId: 'req-42',
        baseUrl: 'https://app.balo.expert',
      })
    );
    expect(html).toContain('Priya Nair');
    expect(html).toContain('Review the proposal');
    expect(html).toContain('https://app.balo.expert/projects/req-42');
  });
});

describe('ProjectProposalAcceptedEmail', () => {
  it('returns a React element carrying the client name', () => {
    const element = ProjectProposalAcceptedEmail({
      firstName: 'Priya',
      clientName: 'Dana Whitfield',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('renders a congratulatory message and a link to the project', async () => {
    const html = await render(
      ProjectProposalAcceptedEmail({
        firstName: 'Priya',
        clientName: 'Dana Whitfield',
        projectTitle: 'CPQ implementation',
        projectRequestId: 'req-42',
        baseUrl: 'https://app.balo.expert',
      })
    );
    expect(html).toContain('Your proposal was accepted');
    expect(html).toContain('Dana Whitfield');
    expect(html).toContain('https://app.balo.expert/projects/req-42');
  });

  it('appends the company on first mention as "Name @ Company" when clientCompany is passed', async () => {
    const html = await render(
      ProjectProposalAcceptedEmail({
        firstName: 'Priya',
        clientName: 'Dana Whitfield',
        clientCompany: 'Acme Corp',
        projectTitle: 'CPQ implementation',
        projectRequestId: 'req-42',
        baseUrl: 'https://app.balo.expert',
      })
    );
    expect(html).toContain('Dana Whitfield @ Acme Corp');
  });
});

describe('ProjectKickoffApprovedExpertEmail', () => {
  it('returns a React element', () => {
    const element = ProjectKickoffApprovedExpertEmail({
      firstName: 'Priya',
      counterpartName: 'Dana Whitfield',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('renders the deliver message, the client (with company on first mention), and a link', async () => {
    const html = await render(
      ProjectKickoffApprovedExpertEmail({
        firstName: 'Priya',
        counterpartName: 'Dana Whitfield',
        counterpartCompany: 'Acme Corp',
        projectTitle: 'CPQ implementation',
        projectRequestId: 'req-42',
        baseUrl: 'https://app.balo.expert',
      })
    );
    expect(html).toContain('Kickoff approved — time to deliver');
    expect(html).toContain('Dana Whitfield @ Acme Corp');
    expect(html).toContain('https://app.balo.expert/projects/req-42');
  });
});

describe('ProjectKickoffApprovedClientEmail', () => {
  it('returns a React element', () => {
    const element = ProjectKickoffApprovedClientEmail({
      firstName: 'Dana',
      counterpartName: 'Priya Nair',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('renders the expert-ready message and a link to the project', async () => {
    const html = await render(
      ProjectKickoffApprovedClientEmail({
        firstName: 'Dana',
        counterpartName: 'Priya Nair',
        projectTitle: 'CPQ implementation',
        projectRequestId: 'req-42',
        baseUrl: 'https://app.balo.expert',
      })
    );
    expect(html).toContain('Kickoff approved — Priya Nair is ready');
    expect(html).toContain('https://app.balo.expert/projects/req-42');
  });
});

describe('ProjectChangesRequestedEmail', () => {
  it('returns a React element carrying the client name', () => {
    const element = ProjectChangesRequestedEmail({
      firstName: 'Priya',
      clientName: 'Dana Whitfield',
      section: 'pricing',
      note: 'Could we split milestone 2 into two passes?',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('renders the client name, the requested section, the revise CTA, and a link to the request', async () => {
    const html = await render(
      ProjectChangesRequestedEmail({
        firstName: 'Priya',
        clientName: 'Dana Whitfield',
        section: 'pricing',
        note: 'Could we split milestone 2 into two passes?',
        projectTitle: 'CPQ implementation',
        projectRequestId: 'req-42',
        baseUrl: 'https://app.balo.expert',
      })
    );
    expect(html).toContain('Dana Whitfield');
    expect(html).toContain('requested changes');
    expect(html).toContain('pricing');
    expect(html).toContain('Revise your proposal');
    expect(html).toContain('https://app.balo.expert/projects/req-42');
  });
});

describe('ProjectProposalResubmittedEmail', () => {
  it('returns a React element carrying the expert name', () => {
    const element = ProjectProposalResubmittedEmail({
      firstName: 'Dana',
      expertName: 'Priya Nair',
      version: 2,
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('renders the expert name, the new version, the review CTA, and a link to the request', async () => {
    const html = await render(
      ProjectProposalResubmittedEmail({
        firstName: 'Dana',
        expertName: 'Priya Nair',
        version: 2,
        projectTitle: 'CPQ implementation',
        projectRequestId: 'req-42',
        baseUrl: 'https://app.balo.expert',
      })
    );
    expect(html).toContain('Priya Nair');
    expect(html).toContain('v2');
    expect(html).toContain('Review the proposal');
    expect(html).toContain('https://app.balo.expert/projects/req-42');
  });
});

describe('ProjectProposalNotSelectedEmail', () => {
  it('returns a React element', () => {
    const element = ProjectProposalNotSelectedEmail({
      firstName: 'Priya',
      projectTitle: 'CPQ implementation',
      projectRequestId: 'req-1',
      baseUrl: 'https://app.balo.expert',
    });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('renders a gracious message and a link to the project', async () => {
    const html = await render(
      ProjectProposalNotSelectedEmail({
        firstName: 'Priya',
        projectTitle: 'CPQ implementation',
        projectRequestId: 'req-42',
        baseUrl: 'https://app.balo.expert',
      })
    );
    expect(html).toContain('The client chose another proposal');
    expect(html).toContain('https://app.balo.expert/projects/req-42');
  });
});

describe('getEmailTemplate — A2 templates', () => {
  it('resolves project-exploratory-requested with a scoping subject', () => {
    const { component, subject } = getEmailTemplate('project-exploratory-requested', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      recipientName: 'Dana',
    });
    expect(component).toBeDefined();
    expect(subject).toBe("Let's scope your project: CPQ implementation");
  });

  it('resolves project-expert-invited with an invite subject', () => {
    const { component, subject } = getEmailTemplate('project-expert-invited', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      recipientName: 'Priya',
    });
    expect(component).toBeDefined();
    expect(subject).toBe("You're invited: CPQ implementation");
  });

  it('resolves project-eoi-submitted with an interest subject + carries the expert name', () => {
    const { component, subject } = getEmailTemplate('project-eoi-submitted', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      recipientName: 'Dana',
      expertName: 'Priya Nair',
    });
    expect(component).toBeDefined();
    expect(subject).toBe('An expert is interested in CPQ implementation');
  });

  it('resolves project-proposal-requested with a proposal subject', () => {
    const { component, subject } = getEmailTemplate('project-proposal-requested', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      recipientName: 'Priya',
    });
    expect(component).toBeDefined();
    expect(subject).toBe('Proposal requested: CPQ implementation');
  });

  it('resolves project-proposal-submitted with an expert-named subject', () => {
    const { component, subject } = getEmailTemplate('project-proposal-submitted', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      recipientName: 'Dana',
      expertName: 'Priya Nair',
    });
    expect(component).toBeDefined();
    expect(subject).toBe('Priya Nair sent your proposal: CPQ implementation');
  });

  it('falls back to default names when project-proposal-submitted payload is sparse', () => {
    const { subject } = getEmailTemplate('project-proposal-submitted', {});
    expect(subject).toBe('Your expert sent your proposal: a project');
  });

  it('resolves project-proposal-accepted with a congratulatory subject (BAL-289)', () => {
    const { component, subject } = getEmailTemplate('project-proposal-accepted', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      recipientName: 'Priya',
      clientName: 'Dana Whitfield',
    });
    expect(component).toBeDefined();
    expect(subject).toBe('Your proposal was accepted: CPQ implementation');
  });

  it('resolves project-kickoff-approved-expert with a deliver subject (BAL-291)', () => {
    const { component, subject } = getEmailTemplate('project-kickoff-approved-expert', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      recipientName: 'Priya',
      clientName: 'Dana Whitfield',
      clientCompanyName: 'Acme Corp',
    });
    expect(component).toBeDefined();
    expect(subject).toBe('Kickoff approved — time to deliver: CPQ implementation');
  });

  it('resolves project-kickoff-approved-client with an expert-ready subject (BAL-291)', () => {
    const { component, subject } = getEmailTemplate('project-kickoff-approved-client', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      recipientName: 'Dana',
      expertName: 'Priya Nair',
    });
    expect(component).toBeDefined();
    expect(subject).toBe('Kickoff approved — Priya Nair is ready: CPQ implementation');
  });

  it('resolves project-proposal-not-selected with an update subject (BAL-289)', () => {
    const { component, subject } = getEmailTemplate('project-proposal-not-selected', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      recipientName: 'Priya',
    });
    expect(component).toBeDefined();
    expect(subject).toBe('An update on your proposal: CPQ implementation');
  });

  it('resolves project-billing-reminder-owner with a complete-billing subject + CTA (BAL-324)', async () => {
    const { component, subject } = getEmailTemplate('project-billing-reminder-owner', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      companyName: 'Acme Corp',
      recipientName: 'Dana',
    });
    const html = await render(component);
    expect(subject).toBe('Complete your billing details to start CPQ implementation');
    // Owner variant carries the action button pointing at the request.
    expect(html).toContain('Complete billing details');
    expect(html).toContain('/projects/req-1');
    expect(html).toContain('Acme Corp');
  });

  it('resolves project-billing-reminder-creator as a no-CTA FYI (BAL-324)', async () => {
    const { component, subject } = getEmailTemplate('project-billing-reminder-creator', {
      title: 'CPQ implementation',
      projectRequestId: 'req-1',
      companyName: 'Acme Corp',
      recipientName: 'Sam',
    });
    const html = await render(component);
    expect(subject).toBe('Billing details are still needed to start CPQ implementation');
    // FYI variant has NO action button and no request link.
    expect(html).not.toContain('Complete billing details');
    expect(html).not.toContain('/projects/req-1');
    expect(html).toContain('Acme Corp');
  });

  it('resolves expert-referral-invited with an inviter-named subject (BAL-325)', () => {
    const { component, subject } = getEmailTemplate('expert-referral-invited', {
      inviterName: 'Ada Lovelace',
    });
    expect(component).toBeDefined();
    expect(subject).toBe('Ada Lovelace invited you to join Balo as an expert');
  });

  it('falls back to a neutral inviter name when expert-referral-invited payload is sparse', () => {
    const { subject } = getEmailTemplate('expert-referral-invited', {});
    expect(subject).toBe('A colleague invited you to join Balo as an expert');
  });

  it('sanitizes a hostile inviterName in the expert-referral-invited subject', () => {
    const { subject } = getEmailTemplate('expert-referral-invited', {
      inviterName: 'Ada\r\nBcc: attacker@evil.com',
    });
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('throws on an unknown template name', () => {
    expect(() => getEmailTemplate('does-not-exist', {})).toThrow(/Unknown email template/);
  });
});

describe('sanitizeSubjectTitle', () => {
  it('replaces CR/LF and other control characters with spaces', () => {
    expect(sanitizeSubjectTitle('CPQ\r\nBcc: attacker@evil.com')).toBe(
      'CPQ  Bcc: attacker@evil.com'
    );
    expect(sanitizeSubjectTitle('tab\there\u0000null')).toBe('tab here null');
  });

  it('trims and caps at 160 characters', () => {
    expect(sanitizeSubjectTitle('  padded  ')).toBe('padded');
    expect(sanitizeSubjectTitle('a'.repeat(500))).toHaveLength(160);
  });

  it('leaves a normal title untouched', () => {
    expect(sanitizeSubjectTitle('CPQ implementation')).toBe('CPQ implementation');
  });

  it('is applied to every user-authored title subject (header-injection guard)', () => {
    const hostile = 'CPQ\r\nBcc: attacker@evil.com';
    const templateNames = [
      'project-request-submitted',
      'project-match-requested',
      'project-exploratory-requested',
      'project-expert-invited',
      'project-eoi-submitted',
      'project-proposal-requested',
      'project-proposal-submitted',
      'project-proposal-accepted',
      'project-kickoff-approved-expert',
      'project-kickoff-approved-client',
      'project-proposal-not-selected',
      'project-billing-reminder-owner',
      'project-billing-reminder-creator',
    ];
    for (const name of templateNames) {
      const { subject } = getEmailTemplate(name, {
        title: hostile,
        projectRequestId: 'req-1',
        recipientName: 'Dana',
        expertName: 'Priya Nair',
        clientName: 'Dana Whitfield',
        company: { name: 'Acme Inc' },
      });
      expect(subject).not.toMatch(/[\r\n]/);
    }
  });
});

describe('pluralize', () => {
  it('uses the singular form for a count of 1', () => {
    expect(pluralize(1, 'document')).toBe('1 document');
  });

  it('uses the plural form for counts other than 1', () => {
    expect(pluralize(0, 'document')).toBe('0 documents');
    expect(pluralize(3, 'product')).toBe('3 products');
  });
});

describe('buildSelectionSummary', () => {
  it('joins non-zero parts with a middot', () => {
    expect(buildSelectionSummary({ tagCount: 3, productCount: 2, documentCount: 1 })).toBe(
      '3 project types · 2 products · 1 document attached'
    );
  });

  it('omits zero-count parts', () => {
    expect(buildSelectionSummary({ tagCount: 1, productCount: 0, documentCount: 0 })).toBe(
      '1 project type'
    );
  });

  it('returns an empty string when everything is zero', () => {
    expect(buildSelectionSummary({ tagCount: 0, productCount: 0, documentCount: 0 })).toBe('');
  });
});

describe('shared components', () => {
  it('EmailShell renders with children', () => {
    const element = EmailShell({
      previewText: 'Test preview',
      baseUrl: 'https://app.balo.expert',
      children: 'Hello',
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('LogoRow renders at default size', () => {
    const element = LogoRow({});
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('LogoRow renders at small size', () => {
    const element = LogoRow({ size: 'small' });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('StatusPill renders with label', () => {
    const element = StatusPill({ label: '⏳ Under Review', style: { color: 'white' } });
    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('Callout renders with all props', () => {
    const element = Callout({
      emoji: '💡',
      heading: 'Test heading',
      text: 'Test text',
      bg: '#F5F3FF',
      borderColor: '#DDD6FE',
      headingColor: '#7C3AED',
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });

  it('SupportFooter renders with default prefix', () => {
    const element = SupportFooter({});
    expect(element).toBeDefined();
  });

  it('SupportFooter renders with custom prefix', () => {
    const element = SupportFooter({ prefix: 'Need help?' });
    expect(element).toBeDefined();
  });
});
