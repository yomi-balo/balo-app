import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockCronofyConstructor = vi.fn();

vi.mock('cronofy', () => {
  return {
    default: class MockCronofy {
      constructor(opts: Record<string, unknown>) {
        mockCronofyConstructor(opts);
      }
    },
  };
});

import { getCronofyAppClient, getCronofyUserClient } from './cronofy';

describe('cronofy client helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRONOFY_CLIENT_ID = 'test-client-id';
    process.env.CRONOFY_CLIENT_SECRET = 'test-client-secret';
    process.env.CRONOFY_DATA_CENTER = 'api-au';
  });

  afterEach(() => {
    delete process.env.CRONOFY_CLIENT_ID;
    delete process.env.CRONOFY_CLIENT_SECRET;
    delete process.env.CRONOFY_DATA_CENTER;
  });

  describe('getCronofyAppClient', () => {
    it('creates a Cronofy client with config from env', () => {
      getCronofyAppClient();
      expect(mockCronofyConstructor).toHaveBeenCalledWith({
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        data_center: 'api-au',
      });
    });

    it('throws when CRONOFY_CLIENT_ID is missing', () => {
      delete process.env.CRONOFY_CLIENT_ID;
      expect(() => getCronofyAppClient()).toThrow('Missing Cronofy configuration');
    });

    it('throws when CRONOFY_CLIENT_SECRET is missing', () => {
      delete process.env.CRONOFY_CLIENT_SECRET;
      expect(() => getCronofyAppClient()).toThrow('Missing Cronofy configuration');
    });

    it('throws when CRONOFY_DATA_CENTER is missing', () => {
      delete process.env.CRONOFY_DATA_CENTER;
      expect(() => getCronofyAppClient()).toThrow('Missing Cronofy configuration');
    });
  });

  describe('getCronofyUserClient', () => {
    it('creates a Cronofy client with access token', () => {
      getCronofyUserClient('user-token-123');
      expect(mockCronofyConstructor).toHaveBeenCalledWith({
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        data_center: 'api-au',
        access_token: 'user-token-123',
      });
    });

    it('throws when env vars are missing', () => {
      delete process.env.CRONOFY_CLIENT_ID;
      expect(() => getCronofyUserClient('token')).toThrow('Missing Cronofy configuration');
    });
  });
});
