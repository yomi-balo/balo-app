import { describe, it, expect } from 'vitest';
import { WelcomeEmail } from './welcome.js';
import { ApplicationSubmittedEmail } from './application-submitted.js';

describe('WelcomeEmail', () => {
  it('returns a React element', () => {
    const element = WelcomeEmail({
      recipientName: 'Alice',
      baseUrl: 'https://app.balo.expert',
    });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});

describe('ApplicationSubmittedEmail', () => {
  it('returns a React element', () => {
    const element = ApplicationSubmittedEmail({ recipientName: 'Bob' });

    expect(element).toBeDefined();
    expect(element.type).toBeDefined();
  });
});
