import { describe, expect, it } from 'vitest';
import {
  CALL_STILL_OPEN_HEADLINE,
  CASE_CLOSED_HEADLINE,
  clientCallStillOpenBody,
  clientCaseClosedBody,
  expertCallStillOpenBody,
  expertCaseClosedBody,
} from './end-of-call-copy';

/**
 * BAL-474 (R6-C5, owner-approved) — every string pinned by equality against its FULL literal, `{Name}`
 * interpolation included.
 */
describe('end-of-call copy — the call is still open (R6-C5)', () => {
  it('⚠⚠ the headline is the approved literal', () => {
    expect(CALL_STILL_OPEN_HEADLINE).toBe('Your call is still open');
  });

  it('⚠⚠ the client body is the approved literal, with the name interpolated', () => {
    expect(clientCallStillOpenBody('Amara')).toBe(
      'You can rejoin from the case page — the call stays open until its start time. Time you and Amara spent together before then is part of this consultation.'
    );
  });

  it('⚠⚠ the expert body is the approved literal, with the name interpolated', () => {
    expect(expertCallStillOpenBody('Northwind Industrial')).toBe(
      'You can rejoin from the case page — the call stays open until its start time. Time you and Northwind Industrial spent together before then counts toward this session.'
    );
  });

  it('⚠ the two bodies differ only in their closing clause', () => {
    expect(clientCallStillOpenBody('X')).not.toBe(expertCallStillOpenBody('X'));
  });

  it('⚠ neither body uses a gendered pronoun', () => {
    for (const body of [clientCallStillOpenBody('Amara'), expertCallStillOpenBody('Amara')]) {
      const words = body.toLowerCase().split(/[^a-z]+/);
      for (const banned of ['he', 'she', 'him', 'her', 'his', 'hers']) {
        expect(words).not.toContain(banned);
      }
    }
  });
});

/**
 * BAL-474 (R6F-2, D15.4, owner-approved) — the voided no-show's end-of-call strings, pinned by equality against
 * their FULL literals. The apostrophes are ASCII.
 */
describe('end-of-call copy — the case was closed before the start (R6F-2)', () => {
  const DANA = { closedByFirstName: 'Dana', companyName: 'Northwind Industrial' } as const;
  const NO_CLOSER = { closedByFirstName: null, companyName: 'Northwind Industrial' } as const;
  const NO_COMPANY = { closedByFirstName: 'Dana', companyName: null } as const;
  const NEITHER = { closedByFirstName: null, companyName: null } as const;

  it('⚠⚠ the title is the approved literal, shared by both lenses', () => {
    expect(CASE_CLOSED_HEADLINE).toBe('This case was closed');
  });

  it('⚠⚠ the expert body names the person @ company', () => {
    expect(expertCaseClosedBody(DANA)).toBe(
      "Dana @ Northwind Industrial closed this case before the start time, so this call isn't billed and no payout is recorded."
    );
  });

  it('⚠⚠ the client body names the person @ company', () => {
    expect(clientCaseClosedBody(DANA)).toBe(
      "Dana @ Northwind Industrial closed this case before the start time, so this consultation didn't take place and nothing was charged."
    );
  });

  it('⚠⚠ with no closer, both bodies open "This case was closed before the start time"', () => {
    for (const closure of [NO_CLOSER, NEITHER]) {
      expect(expertCaseClosedBody(closure)).toBe(
        "This case was closed before the start time, so this call isn't billed and no payout is recorded."
      );
      expect(clientCaseClosedBody(closure)).toBe(
        "This case was closed before the start time, so this consultation didn't take place and nothing was charged."
      );
    }
  });

  it('⚠⚠ a missing company reads "their team" in the attribution', () => {
    expect(expertCaseClosedBody(NO_COMPANY)).toBe(
      "Dana @ their team closed this case before the start time, so this call isn't billed and no payout is recorded."
    );
    expect(clientCaseClosedBody(NO_COMPANY)).toBe(
      "Dana @ their team closed this case before the start time, so this consultation didn't take place and nothing was charged."
    );
  });

  it('⚠ neither body promises a recap, receipt or payout summary, or uses a gendered pronoun', () => {
    for (const closure of [DANA, NO_CLOSER, NO_COMPANY, NEITHER]) {
      for (const body of [expertCaseClosedBody(closure), clientCaseClosedBody(closure)]) {
        expect(body.toLowerCase()).not.toMatch(/recap|receipt|payout summary|on the way/);
        const words = body.toLowerCase().split(/[^a-z]+/);
        for (const banned of ['he', 'she', 'him', 'her', 'his', 'hers']) {
          expect(words).not.toContain(banned);
        }
      }
    }
  });
});
