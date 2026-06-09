import { describe, it, expect } from 'vitest';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';
import { ExpertApprovedEmail } from './expert-approved.js';
import { ProjectRequestSubmittedEmail } from './project-request-submitted.js';
import { ProjectMatchRequestedEmail } from './project-match-requested.js';
import { ProjectExploratoryRequestedEmail } from './project-exploratory-requested.js';
import { ProjectExpertInvitedEmail } from './project-expert-invited.js';
import { getEmailTemplate } from './index.js';
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

  it('throws on an unknown template name', () => {
    expect(() => getEmailTemplate('does-not-exist', {})).toThrow(/Unknown email template/);
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
