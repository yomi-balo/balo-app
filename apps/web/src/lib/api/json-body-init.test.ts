import { describe, expect, it } from 'vitest';

import { jsonBodyInit, type ApiMethod } from './json-body-init';

describe('jsonBodyInit', () => {
  it.each<ApiMethod>(['GET', 'DELETE'])(
    '%s carries no body and no JSON content type, even when handed a body',
    (method) => {
      const withoutBody = jsonBodyInit(method);
      const withBody = jsonBodyInit(method, { ignored: true });

      for (const init of [withoutBody, withBody]) {
        expect(init.headers).toEqual({});
        expect('body' in init).toBe(false);
      }
    }
  );

  it.each<ApiMethod>(['POST', 'PUT', 'PATCH'])(
    '%s with no body sends `{}` under the JSON content type',
    (method) => {
      expect(jsonBodyInit(method)).toEqual({
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    }
  );

  it.each<ApiMethod>(['POST', 'PUT', 'PATCH'])('%s with an object sends its JSON', (method) => {
    expect(jsonBodyInit(method, { a: 1 })).toEqual({
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
  });
});
