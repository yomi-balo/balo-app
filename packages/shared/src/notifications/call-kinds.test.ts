import { describe, expect, it } from 'vitest';
import { CALL_KINDS } from './index';

describe('CALL_KINDS', () => {
  it('names the intro and won-expert call copies', () => {
    expect(CALL_KINDS).toEqual(['intro', 'call']);
  });
});
