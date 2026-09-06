import { describe, expect, it } from 'vitest';
import {
  CLOSE_REASONS,
  REASON_LABEL,
  CLOSE_NOTE_MIN_LENGTH,
  declineVerbFor,
  declineTitleFor,
  declineBodyFor,
  consequenceFor,
  closeNotePlaceholderFor,
  type TrackStage,
} from './close-copy';

const ALL_STAGES: readonly TrackStage[] = [
  'invited',
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
];

describe('close-copy', () => {
  it('CLOSE_REASONS never includes withdrawn — that is the client-only reason', () => {
    expect(CLOSE_REASONS.map((r) => r.key)).toEqual(['declined', 'unfilled', 'superseded']);
    for (const reason of CLOSE_REASONS) {
      expect(reason.label.length).toBeGreaterThan(0);
      expect(reason.hint.length).toBeGreaterThan(0);
    }
  });

  it('REASON_LABEL covers all four labels including withdrawn', () => {
    expect(REASON_LABEL).toEqual({
      withdrawn: 'Withdrawn',
      declined: 'Balo declined',
      unfilled: 'Unfilled',
      superseded: 'Superseded',
    });
  });

  it('declineVerbFor: "Withdraw invite" only for invited, "Decline" otherwise', () => {
    expect(declineVerbFor('invited')).toBe('Withdraw invite');
    for (const stage of ALL_STAGES.filter((s) => s !== 'invited')) {
      expect(declineVerbFor(stage)).toBe('Decline');
    }
  });

  it('declineTitleFor names the expert and the right noun per stage', () => {
    expect(declineTitleFor('invited', 'Aisha Bello')).toBe('Withdraw Aisha Bello’s invitation?');
    expect(declineTitleFor('eoi_submitted', 'Marcus Lee')).toBe(
      'Decline Marcus Lee’s expression of interest?'
    );
    expect(declineTitleFor('proposal_requested', 'Marcus Lee')).toBe(
      'Decline Marcus Lee’s expression of interest?'
    );
    expect(declineTitleFor('proposal_submitted', 'Priya Nair')).toBe(
      'Decline Priya Nair’s proposal?'
    );
  });

  it('declineBodyFor: invited names the invitation withdrawal, never the files rule text', () => {
    const body = declineBodyFor('invited', 'CloudPeak');
    expect(body).toContain('CloudPeak is told the invitation was withdrawn');
    expect(body).not.toContain('not proceeding');
  });

  it('declineBodyFor: proposal_submitted mentions the declined proposal AND the files rule', () => {
    const body = declineBodyFor('proposal_submitted', 'CloudPeak');
    expect(body).toContain('not proceeding');
    expect(body).toContain('proposal is declined');
    expect(body).toContain('files they had access to stay exactly as they were');
  });

  it('declineBodyFor: eoi_submitted/proposal_requested share the same non-proposal body', () => {
    expect(declineBodyFor('eoi_submitted', 'CloudPeak')).toBe(
      declineBodyFor('proposal_requested', 'CloudPeak')
    );
  });

  it('consequenceFor is exhaustive and prospective — names the party, never the viewer', () => {
    for (const stage of ALL_STAGES) {
      const text = consequenceFor({ expertName: 'Priya Nair', partyLabel: 'CloudPeak', stage });
      expect(text).toContain('Priya Nair');
      expect(text).toContain('CloudPeak');
    }
  });

  it('consequenceFor: proposal_submitted mentions withdrawal of the proposal specifically', () => {
    const text = consequenceFor({
      expertName: 'Priya Nair',
      partyLabel: 'CloudPeak',
      stage: 'proposal_submitted',
    });
    expect(text).toContain('proposal is withdrawn');
  });

  it('CLOSE_NOTE_MIN_LENGTH is a positive, non-trivial minimum', () => {
    expect(CLOSE_NOTE_MIN_LENGTH).toBeGreaterThanOrEqual(8);
  });

  it('closeNotePlaceholderFor names the company and never suggests the note is visible to them', () => {
    const placeholder = closeNotePlaceholderFor('Northwind Industrial');
    expect(placeholder).toContain('Northwind Industrial');
    expect(placeholder).toMatch(/never shown/i);
  });
});
