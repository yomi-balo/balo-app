import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { rejectNonJsonContentType } from './require-json-content-type';

const URL_ = new URL('http://localhost:3000/api/notifications/seen');

function makeRequest(contentType: string): NextRequest {
  return new NextRequest(URL_, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: '{}',
  });
}

describe('rejectNonJsonContentType', () => {
  it.each([
    ['application/json'],
    ['application/json; charset=utf-8'],
    ['Application/JSON;charset=UTF-8'],
  ])('allows %s', (contentType) => {
    expect(rejectNonJsonContentType(makeRequest(contentType))).toBeNull();
  });

  it.each([
    ['text/plain'],
    ['application/x-www-form-urlencoded'],
    ['multipart/form-data; boundary=x'],
    ['application/jsonp'],
  ])('rejects %s with 415', async (contentType) => {
    const res = rejectNonJsonContentType(makeRequest(contentType));

    expect(res?.status).toBe(415);
    expect(await res?.json()).toEqual({ error: 'Unsupported media type' });
  });

  it('rejects a request with no content type', () => {
    const res = rejectNonJsonContentType(new NextRequest(URL_, { method: 'POST' }));

    expect(res?.status).toBe(415);
  });
});
