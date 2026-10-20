import { describe, it, expect } from 'vitest';
import { REQUEST_DOCUMENT_SERVER_EVENTS } from './request-documents';

describe('REQUEST_DOCUMENT_SERVER_EVENTS', () => {
  it('has exactly the expected keys', () => {
    expect(Object.keys(REQUEST_DOCUMENT_SERVER_EVENTS)).toEqual(['DOWNLOADED']);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(REQUEST_DOCUMENT_SERVER_EVENTS.DOWNLOADED).toBe('request_document_downloaded');
  });

  it('every value carries the request_document_ prefix and snake_case shape', () => {
    for (const value of Object.values(REQUEST_DOCUMENT_SERVER_EVENTS)) {
      expect(value).toMatch(/^request_document_[a-z]+(_[a-z]+)*$/);
    }
  });
});
