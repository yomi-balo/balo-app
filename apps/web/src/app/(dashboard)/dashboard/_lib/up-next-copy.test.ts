import { describe, it, expect } from 'vitest';
import {
  UP_NEXT_COPY,
  upNextStartsIn,
  UP_NEXT_BALO_PARTY_NAME,
  UP_NEXT_TITLE,
} from './up-next-copy';

describe('UP_NEXT_COPY (BAL-566)', () => {
  it('names the company in the company subtitle', () => {
    expect(UP_NEXT_COPY.company.subtitle('Northwind Industrial')).toBe(
      'Meetings across Northwind Industrial’s cases and projects'
    );
  });

  it('the expert subtitle never names a company', () => {
    expect(UP_NEXT_COPY.expert.subtitle('anything')).toBe(
      'Your meetings across cases and projects'
    );
  });

  it('reschedule note copy differs by workspace, party-vs-person framing', () => {
    expect(UP_NEXT_COPY.company.rescheduleNote).toBe('New times suggested');
    expect(UP_NEXT_COPY.expert.rescheduleNote).toBe('Waiting on their reply');
  });

  it('personal-workspace names still compose (an MJ checkpoint, not a bug)', () => {
    expect(UP_NEXT_COPY.company.subtitle('Jane’s Workspace')).toBe(
      'Meetings across Jane’s Workspace’s cases and projects'
    );
  });
});

describe('upNextStartsIn', () => {
  it('formats minutes', () => {
    expect(upNextStartsIn(1)).toBe('Starts in 1 min');
    expect(upNextStartsIn(14)).toBe('Starts in 14 min');
  });
});

describe('misc constants', () => {
  it('the heading is "Up next" and Balo is the match-routed party name', () => {
    expect(UP_NEXT_TITLE).toBe('Up next');
    expect(UP_NEXT_BALO_PARTY_NAME).toBe('Balo');
  });
});
