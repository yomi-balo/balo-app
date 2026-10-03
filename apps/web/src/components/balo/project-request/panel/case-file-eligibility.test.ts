import { describe, it, expect } from 'vitest';
import { caseFileEligibility } from './case-file-eligibility';

const OK_PDF = { contentType: 'application/pdf', sizeBytes: 1000 };
const OVERSIZE_PDF = { contentType: 'application/pdf', sizeBytes: 6 * 1024 * 1024 };
const DOCX = { contentType: 'application/msword', sizeBytes: 1000 };
const OVERSIZE_DOCX = { contentType: 'application/msword', sizeBytes: 6 * 1024 * 1024 };

describe('caseFileEligibility', () => {
  it('is eligible for a supported, within-size file under the cap', () => {
    expect(caseFileEligibility(OK_PDF, false, 0)).toBe('eligible');
  });

  it('flags an oversize file regardless of selection or cap', () => {
    expect(caseFileEligibility(OVERSIZE_PDF, false, 0)).toBe('too_large');
  });

  it('flags an unsupported type when within size and under the cap', () => {
    expect(caseFileEligibility(DOCX, false, 0)).toBe('unsupported_type');
  });

  it('checks size BEFORE type — an oversize unsupported file reads as too_large', () => {
    expect(caseFileEligibility(OVERSIZE_DOCX, false, 0)).toBe('too_large');
  });

  it('checks type BEFORE the cap — an unsupported file at the cap reads as unsupported_type', () => {
    expect(caseFileEligibility(DOCX, false, 4)).toBe('unsupported_type');
  });

  it('locks out an unselected file once the cap is reached', () => {
    expect(caseFileEligibility(OK_PDF, false, 4)).toBe('at_cap');
  });

  it('never locks out a file that is ALREADY selected, even at the cap', () => {
    expect(caseFileEligibility(OK_PDF, true, 4)).toBe('eligible');
  });

  it('is eligible exactly at the size boundary (5 MB)', () => {
    expect(
      caseFileEligibility({ contentType: 'application/pdf', sizeBytes: 5 * 1024 * 1024 }, false, 0)
    ).toBe('eligible');
  });

  it('is eligible one short of the cap', () => {
    expect(caseFileEligibility(OK_PDF, false, 3)).toBe('eligible');
  });
});
