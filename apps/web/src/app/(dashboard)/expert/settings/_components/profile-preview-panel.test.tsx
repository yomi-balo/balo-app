import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ExpertCardData } from '@/components/expert';

// ExpertCard is exercised by its own suite; stub it so this test focuses on the
// preview panel's own logic (completeness derivation + conditional sections).
vi.mock('@/components/expert', () => ({
  ExpertCard: () => <div data-testid="expert-card" />,
}));

// Surface each completeness field's label + done state so we can assert the
// changed `completenessFields` derivation (avatarUrl / headline driven).
vi.mock('./completeness-bar', () => ({
  CompletenessBar: ({ fields }: { fields: { label: string; done: boolean }[] }) => (
    <ul>
      {fields.map((f) => (
        <li key={f.label} data-testid={`field-${f.label}`} data-done={String(f.done)}>
          {f.label}
        </li>
      ))}
    </ul>
  ),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

import { ProfilePreviewPanel } from './profile-preview-panel';

function makeExpert(overrides: Partial<ExpertCardData> = {}): ExpertCardData {
  return {
    id: 'expert-1',
    username: 'jane-doe',
    name: 'Jane Doe',
    initials: 'JD',
    avatarUrl: null,
    headline: null,
    bio: null,
    countryCode: 'AU',
    rate: null,
    nextAvailableAt: null,
    languages: [],
    agency: null,
    distinctions: {
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
    },
    rating: null,
    reviewCount: 0,
    yearsExperience: null,
    consultationCount: 0,
    expertise: [],
    ...overrides,
  };
}

describe('ProfilePreviewPanel', () => {
  it('marks "Profile photo" done only when avatarUrl is set', () => {
    const { rerender } = render(
      <ProfilePreviewPanel expert={makeExpert({ avatarUrl: null })} username="jd" headline="" />
    );
    expect(screen.getByTestId('field-Profile photo')).toHaveAttribute('data-done', 'false');

    rerender(
      <ProfilePreviewPanel
        expert={makeExpert({ avatarUrl: 'avatars/jane.jpg' })}
        username="jd"
        headline=""
      />
    );
    expect(screen.getByTestId('field-Profile photo')).toHaveAttribute('data-done', 'true');
  });

  it('marks "Headline" done only when headline is set', () => {
    const { rerender } = render(
      <ProfilePreviewPanel expert={makeExpert({ headline: null })} username="jd" headline="" />
    );
    expect(screen.getByTestId('field-Headline')).toHaveAttribute('data-done', 'false');

    rerender(
      <ProfilePreviewPanel
        expert={makeExpert({ headline: 'Senior Salesforce Architect' })}
        username="jd"
        headline=""
      />
    );
    expect(screen.getByTestId('field-Headline')).toHaveAttribute('data-done', 'true');
  });

  it('marks "Bio (min 80 chars)" done only when the bio reaches the threshold', () => {
    render(
      <ProfilePreviewPanel
        expert={makeExpert({ bio: 'x'.repeat(80) })}
        username="jane-doe"
        headline=""
      />
    );
    expect(screen.getByTestId('field-Bio (min 80 chars)')).toHaveAttribute('data-done', 'true');
  });

  it('marks "Username" done only when username has at least 3 chars', () => {
    const { rerender } = render(
      <ProfilePreviewPanel expert={makeExpert()} username="ab" headline="" />
    );
    expect(screen.getByTestId('field-Username')).toHaveAttribute('data-done', 'false');

    rerender(<ProfilePreviewPanel expert={makeExpert()} username="abc" headline="" />);
    expect(screen.getByTestId('field-Username')).toHaveAttribute('data-done', 'true');
  });

  it('renders the copyable URL only when username has at least 3 chars', () => {
    const { rerender } = render(
      <ProfilePreviewPanel expert={makeExpert()} username="ab" headline="" />
    );
    expect(screen.queryByLabelText('Copy profile URL')).not.toBeInTheDocument();

    rerender(<ProfilePreviewPanel expert={makeExpert()} username="jane-doe" headline="" />);
    expect(screen.getByLabelText('Copy profile URL')).toBeInTheDocument();
  });

  it('renders the search snippet only when a headline is provided', () => {
    const { rerender } = render(
      <ProfilePreviewPanel expert={makeExpert()} username="jane-doe" headline="" />
    );
    expect(screen.queryByText('Search result snippet')).not.toBeInTheDocument();

    rerender(
      <ProfilePreviewPanel
        expert={makeExpert()}
        username="jane-doe"
        headline="Senior Salesforce Architect"
      />
    );
    expect(screen.getByText('Search result snippet')).toBeInTheDocument();
    expect(screen.getByText('Senior Salesforce Architect')).toBeInTheDocument();
  });
});
