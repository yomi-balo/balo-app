import { describe, it, expect } from 'vitest';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';
import { ExpertApprovedEmail } from './expert-approved.js';
import { EmailShell, LogoRow, StatusPill, Callout, SupportFooter } from './shared.js';

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
