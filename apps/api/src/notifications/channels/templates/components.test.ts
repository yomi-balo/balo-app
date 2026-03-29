import { describe, it, expect } from 'vitest';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';

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
