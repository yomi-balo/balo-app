import { describe, it, expect } from 'vitest';
import { DIRECT_CHOICE_LABEL, directChoiceHeadline } from './direct-request-choice';

describe('direct choice copy', () => {
  it('names the client party in the headline', () => {
    expect(directChoiceHeadline('Northwind')).toBe(
      'Northwind asked for you directly. Take it on, or pass?'
    );
    expect(DIRECT_CHOICE_LABEL).toBe('Take it on, or pass?');
  });
});
