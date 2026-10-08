import { describe, it, expect } from 'vitest';
import { render } from '@react-email/render';
import { EXPERT_APPLICATION_EDIT_SECTIONS } from '@balo/shared/experts';
import {
  ExpertApplicationEditedEmail,
  EXPERT_APPLICATION_EDITED_COPY,
  EXPERT_APPLICATION_EDIT_SECTION_LABEL,
} from './expert-application-edited.js';

const BASE_URL = 'https://app.balo.expert';

describe('EXPERT_APPLICATION_EDITED_COPY', () => {
  it('is the exact shipped copy, sentence for sentence', () => {
    expect(EXPERT_APPLICATION_EDITED_COPY).toEqual({
      heroSubtext: 'A quick update on your expert profile.',
      intro:
        'After reviewing your application, our team updated these parts of your expert profile:',
      liveNote: 'These updates are already live — search and your public profile reflect them now.',
      supportPrefix: "Think something's not right?",
    });
  });
});

describe('EXPERT_APPLICATION_EDIT_SECTION_LABEL', () => {
  it('has exactly one label per section, keyed in EXPERT_APPLICATION_EDIT_SECTIONS order', () => {
    expect(Object.keys(EXPERT_APPLICATION_EDIT_SECTION_LABEL)).toEqual([
      ...EXPERT_APPLICATION_EDIT_SECTIONS,
    ]);
  });

  it('is the exact shipped labels', () => {
    expect(EXPERT_APPLICATION_EDIT_SECTION_LABEL).toEqual({
      ratings: 'Skill ratings',
      products: 'Products',
      certifications: 'Certifications',
      experience: 'Experience',
    });
  });
});

describe('ExpertApplicationEditedEmail', () => {
  it('renders the changed section, the CTA to settings, and the support footer', async () => {
    const html = await render(
      ExpertApplicationEditedEmail({ firstName: 'Priya', sections: ['ratings'], baseUrl: BASE_URL })
    );

    expect(html).toContain('Profile update');
    expect(html).toContain('Balo updated your expertise, Priya');
    expect(html).toContain(EXPERT_APPLICATION_EDIT_SECTION_LABEL.ratings);
    // Only the one changed section renders — not the other three.
    expect(html).not.toContain(EXPERT_APPLICATION_EDIT_SECTION_LABEL.products);
    expect(html).not.toContain(EXPERT_APPLICATION_EDIT_SECTION_LABEL.certifications);
    expect(html).not.toContain(EXPERT_APPLICATION_EDIT_SECTION_LABEL.experience);

    expect(html).toContain(`${BASE_URL}/expert/settings`);
    expect(html).toContain('Review your profile');
    expect(html).toContain('support@getbalo.com');
    // React escapes `'` to `&#x27;` in rendered text, so the fragment is apostrophe-free —
    // the WHOLE sentence is pinned verbatim above, against the exported constant.
    expect(html).toContain('Think something');
    expect(html).toContain('not right?');
    expect(html).not.toContain('undefined');
  });

  it('renders all four section labels when every section changed', async () => {
    const html = await render(
      ExpertApplicationEditedEmail({
        firstName: 'Priya',
        sections: [...EXPERT_APPLICATION_EDIT_SECTIONS],
        baseUrl: BASE_URL,
      })
    );

    for (const section of EXPERT_APPLICATION_EDIT_SECTIONS) {
      expect(html).toContain(EXPERT_APPLICATION_EDIT_SECTION_LABEL[section]);
    }
    expect(html).not.toContain('undefined');
  });

  it('still greets a missing first name gracefully', async () => {
    const html = await render(
      ExpertApplicationEditedEmail({
        firstName: 'there',
        sections: ['products'],
        baseUrl: BASE_URL,
      })
    );
    // The preview text is built in JS, so it survives rendering as one contiguous string.
    expect(html).toContain('Balo updated your expertise, there.');
  });

  it('names no staff member — only Balo / our team', async () => {
    const html = await render(
      ExpertApplicationEditedEmail({
        firstName: 'Priya',
        sections: ['certifications'],
        baseUrl: BASE_URL,
      })
    );
    expect(html).not.toMatch(/reviewed by|edited by/i);
  });
});
