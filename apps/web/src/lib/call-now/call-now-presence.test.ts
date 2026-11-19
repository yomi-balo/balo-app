import { describe, expect, it } from 'vitest';
import { callNowPresence } from './call-now-presence';

describe('callNowPresence', () => {
  it('reports online and offline from the api’s calleeOnline', () => {
    expect(callNowPresence({ calleeOnline: true })).toBe('online');
    expect(callNowPresence({ calleeOnline: false })).toBe('offline');
  });
});
