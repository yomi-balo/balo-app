import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { getEmailTemplate } from './index.js';
import { getInAppTemplate } from './in-app-templates.js';

// ⚠ `.ts`, NOT `.tsx` — apps/api's vitest globs `src/**/*.{test,spec}.ts` only, so a `.test.tsx`
// never runs and reports green (memory `reference_api_vitest_only_globs_test_ts`).

function clean(html: string): string {
  return html
    .replaceAll('<!-- -->', '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'");
}

const EXPERT_DATA = {
  recipientName: 'Wei',
  clientCompanyName: 'Acme Corp',
  sharedByPersonLabel: 'Sarah Chen',
  fileName: 'Requirements-pack-v2.pdf',
  requestTitle: 'CPQ rollout and billing integration',
  requestId: 'request-123',
};

const CLIENT_DATA = {
  recipientName: 'Sarah',
  expertPartyLabel: 'CloudPeak',
  expertPersonLabel: 'Dan Okafor',
  fileName: 'Dan-proposal-draft.pdf',
  requestTitle: 'CPQ rollout and billing integration',
  requestId: 'request-123',
};

describe('getEmailTemplate — request-file-shared-expert', () => {
  /**
   * ⚠ THE SUBJECT NAMES THE PERSON, SYMMETRICALLY WITH THE CLIENT SIDE. A file share is
   * retrospective copy, which CLAUDE.md attributes to the PERSON — and both bodies already do.
   * The company-named form ("Acme Corp shared a file with you") was the asymmetry.
   */
  it('names the SHARING PERSON in the subject, matching the client-side subject shape', () => {
    const expertOut = getEmailTemplate('request-file-shared-expert', EXPERT_DATA);
    const clientOut = getEmailTemplate('request-file-shared-client', CLIENT_DATA);
    expect(expertOut.subject).toBe('Sarah Chen shared a file with you');
    expect(expertOut.subject).not.toContain('Acme Corp');
    // Same shape both ways: "<person> shared a file…", never "<org> shared a file…".
    expect(expertOut.subject.startsWith(EXPERT_DATA.sharedByPersonLabel)).toBe(true);
    expect(clientOut.subject.startsWith(CLIENT_DATA.expertPersonLabel)).toBe(true);
  });

  it('names the client, the file, the request — and never an audience/count/sibling', async () => {
    const out = getEmailTemplate('request-file-shared-expert', EXPERT_DATA);
    expect(out.subject).toBe('Sarah Chen shared a file with you');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Wei,');
    expect(html).toContain('Sarah Chen @ Acme Corp');
    expect(html).toContain('Requirements-pack-v2.pdf');
    expect(html).toContain('CPQ rollout and billing integration');
    expect(html).toContain('/projects/request-123');
    // ⚠ ADR-1048 §3 — no audience shape may ever leak into this email.
    for (const forbidden of [
      'everyone invited',
      'all_live_tracks',
      'live tracks',
      'Wei Zhang',
      'Priya',
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });
});

describe('getEmailTemplate — request-file-shared-client', () => {
  it('names the expert person "@ party", the file, the request', async () => {
    const out = getEmailTemplate('request-file-shared-client', CLIENT_DATA);
    expect(out.subject).toBe('Dan Okafor shared a file');
    const html = clean(await render(out.component));
    expect(html).toContain('Hi Sarah,');
    expect(html).toContain('Dan Okafor @ CloudPeak');
    expect(html).toContain('Dan-proposal-draft.pdf');
    expect(html).toContain('/projects/request-123');
  });
});

describe('getInAppTemplate — request-file-shared-expert / -client', () => {
  it('has BOTH entries (a missing one silently ships generic copy — getInAppTemplate never throws)', () => {
    const expertOut = getInAppTemplate('request-file-shared-expert', EXPERT_DATA);
    expect(expertOut.title).not.toBe('Notification');
    expect(expertOut.body).not.toBe('You have a new notification');
    expect(expertOut.actionUrl).toBe('/projects/request-123');

    const clientOut = getInAppTemplate('request-file-shared-client', CLIENT_DATA);
    expect(clientOut.title).not.toBe('Notification');
    expect(clientOut.body).not.toBe('You have a new notification');
    expect(clientOut.actionUrl).toBe('/projects/request-123');
  });
});
