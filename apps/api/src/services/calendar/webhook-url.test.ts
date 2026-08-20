import { describe, it, expect, afterEach } from 'vitest';
import {
  APIROC_WEBHOOK_PATH_PREFIX,
  APIROC_WEBHOOK_ROUTE_PATH,
  resolveWebhookBaseUrl,
  buildSubscriptionWebhookUrl,
  subscriptionRowIdFromWebhookUrl,
} from './webhook-url.js';

const ROW_ID = '11111111-1111-4111-8111-111111111111';

describe('webhook-url (BAL-468 §9.1)', () => {
  const original = process.env.APIROC_WEBHOOK_BASE_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.APIROC_WEBHOOK_BASE_URL;
    } else {
      process.env.APIROC_WEBHOOK_BASE_URL = original;
    }
  });

  it('the route path starts with the path prefix (anti-drift lock)', () => {
    expect(APIROC_WEBHOOK_ROUTE_PATH.startsWith(APIROC_WEBHOOK_PATH_PREFIX)).toBe(true);
    expect(APIROC_WEBHOOK_ROUTE_PATH).toBe(`${APIROC_WEBHOOK_PATH_PREFIX}:calendarSubscriptionId`);
  });

  describe('resolveWebhookBaseUrl', () => {
    it('null when unset', () => {
      delete process.env.APIROC_WEBHOOK_BASE_URL;
      expect(resolveWebhookBaseUrl()).toBeNull();
    });

    it('null for a blank/whitespace value', () => {
      process.env.APIROC_WEBHOOK_BASE_URL = '   ';
      expect(resolveWebhookBaseUrl()).toBeNull();
    });

    it('null for a non-https value', () => {
      process.env.APIROC_WEBHOOK_BASE_URL = 'http://api.balo.expert';
      expect(resolveWebhookBaseUrl()).toBeNull();
    });

    it('returns the https origin verbatim', () => {
      process.env.APIROC_WEBHOOK_BASE_URL = 'https://api.balo.expert';
      expect(resolveWebhookBaseUrl()).toBe('https://api.balo.expert');
    });

    it('normalises a trailing slash', () => {
      process.env.APIROC_WEBHOOK_BASE_URL = 'https://api.balo.expert/';
      expect(resolveWebhookBaseUrl()).toBe('https://api.balo.expert');
    });
  });

  describe('buildSubscriptionWebhookUrl', () => {
    it('builds the full https URL with no encoding needed', () => {
      process.env.APIROC_WEBHOOK_BASE_URL = 'https://api.balo.expert';
      expect(buildSubscriptionWebhookUrl(ROW_ID)).toBe(
        `https://api.balo.expert/webhooks/apiroc/calendar/${ROW_ID}`
      );
    });

    it('throws when the base is unconfigured', () => {
      delete process.env.APIROC_WEBHOOK_BASE_URL;
      expect(() => buildSubscriptionWebhookUrl(ROW_ID)).toThrow();
    });
  });

  describe('subscriptionRowIdFromWebhookUrl', () => {
    const prefix = 'https://api.balo.expert/webhooks/apiroc/calendar/';

    it('extracts the row id', () => {
      expect(subscriptionRowIdFromWebhookUrl(`${prefix}${ROW_ID}`, prefix)).toBe(ROW_ID);
    });

    it('rejects a foreign prefix', () => {
      expect(
        subscriptionRowIdFromWebhookUrl(`https://someone-else.example/${ROW_ID}`, prefix)
      ).toBeNull();
    });

    it('rejects a non-uuid tail', () => {
      expect(subscriptionRowIdFromWebhookUrl(`${prefix}not-a-uuid`, prefix)).toBeNull();
    });

    it('rejects an empty tail', () => {
      expect(subscriptionRowIdFromWebhookUrl(prefix, prefix)).toBeNull();
    });
  });
});
