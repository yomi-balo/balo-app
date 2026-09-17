import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { readCalendarSmtpConfig } = await import('./calendar-smtp-config.js');

const ENV_KEYS = [
  'BREVO_SMTP_HOST',
  'BREVO_SMTP_PORT',
  'BREVO_SMTP_USER',
  'BREVO_SMTP_PASS',
  'CALENDAR_INVITE_ORGANIZER_EMAIL',
] as const;

const original: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe('readCalendarSmtpConfig', () => {
  it('returns undefined when unset', () => {
    expect(readCalendarSmtpConfig()).toBeUndefined();
  });

  it('returns undefined when only some vars are set', () => {
    process.env.BREVO_SMTP_USER = 'user';
    expect(readCalendarSmtpConfig()).toBeUndefined();
    process.env.BREVO_SMTP_PASS = 'pass';
    expect(readCalendarSmtpConfig()).toBeUndefined();
  });

  it('defaults host and port when all three required vars are set', () => {
    process.env.BREVO_SMTP_USER = 'user';
    process.env.BREVO_SMTP_PASS = 'pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';

    const config = readCalendarSmtpConfig();
    expect(config).toEqual({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      user: 'user',
      pass: 'pass',
      organizerAddress: 'no-reply@balo.test',
    });
  });

  it('port 465 sets secure: true', () => {
    process.env.BREVO_SMTP_USER = 'user';
    process.env.BREVO_SMTP_PASS = 'pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';
    process.env.BREVO_SMTP_PORT = '465';

    expect(readCalendarSmtpConfig()?.secure).toBe(true);
  });

  it('a malformed port returns undefined and warns, never crashes', () => {
    process.env.BREVO_SMTP_USER = 'user';
    process.env.BREVO_SMTP_PASS = 'pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';
    process.env.BREVO_SMTP_PORT = 'not-a-port';

    expect(() => readCalendarSmtpConfig()).not.toThrow();
    expect(readCalendarSmtpConfig()).toBeUndefined();
    expect(mockWarn).toHaveBeenCalled();
  });

  it('never logs the user, pass or organizer address', () => {
    process.env.BREVO_SMTP_USER = 'secret-user';
    process.env.BREVO_SMTP_PASS = 'secret-pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';
    process.env.BREVO_SMTP_PORT = 'bogus';

    readCalendarSmtpConfig();

    const serialized = JSON.stringify(mockWarn.mock.calls);
    expect(serialized).not.toContain('secret-user');
    expect(serialized).not.toContain('secret-pass');
    expect(serialized).not.toContain('no-reply@balo.test');
  });

  it('a custom host overrides the default', () => {
    process.env.BREVO_SMTP_USER = 'user';
    process.env.BREVO_SMTP_PASS = 'pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';
    process.env.BREVO_SMTP_HOST = 'custom.smtp.test';

    expect(readCalendarSmtpConfig()?.host).toBe('custom.smtp.test');
  });

  it('F18 (fix round 1, R17/S13) — a whitespace-only user/pass/organizer degrades to unconfigured, never AUTH-fails', () => {
    process.env.BREVO_SMTP_USER = '   ';
    process.env.BREVO_SMTP_PASS = 'pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';
    expect(readCalendarSmtpConfig()).toBeUndefined();

    process.env.BREVO_SMTP_USER = 'user';
    process.env.BREVO_SMTP_PASS = '\t\n';
    expect(readCalendarSmtpConfig()).toBeUndefined();

    process.env.BREVO_SMTP_PASS = 'pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = '  ';
    expect(readCalendarSmtpConfig()).toBeUndefined();
  });

  it('F18 — trims a valid user/pass/organizer surrounded by whitespace', () => {
    process.env.BREVO_SMTP_USER = '  user  ';
    process.env.BREVO_SMTP_PASS = '  pass  ';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = '  no-reply@balo.test  ';

    expect(readCalendarSmtpConfig()).toEqual({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      user: 'user',
      pass: 'pass',
      organizerAddress: 'no-reply@balo.test',
    });
  });

  it('F18 — a port above 65535 degrades to unconfigured and warns', () => {
    process.env.BREVO_SMTP_USER = 'user';
    process.env.BREVO_SMTP_PASS = 'pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';
    process.env.BREVO_SMTP_PORT = '70000';

    expect(readCalendarSmtpConfig()).toBeUndefined();
    expect(mockWarn).toHaveBeenCalled();
  });

  it('F18 — port 0 or negative degrades to unconfigured', () => {
    process.env.BREVO_SMTP_USER = 'user';
    process.env.BREVO_SMTP_PASS = 'pass';
    process.env.CALENDAR_INVITE_ORGANIZER_EMAIL = 'no-reply@balo.test';

    process.env.BREVO_SMTP_PORT = '0';
    expect(readCalendarSmtpConfig()).toBeUndefined();

    process.env.BREVO_SMTP_PORT = '-1';
    expect(readCalendarSmtpConfig()).toBeUndefined();
  });
});
