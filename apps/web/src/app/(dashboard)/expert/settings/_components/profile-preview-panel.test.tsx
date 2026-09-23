import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';

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

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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
    ratingCount: 0,
    yearsExperience: null,
    consultationCount: 0,
    expertise: [],
    ...overrides,
  };
}

/** True when `a` comes before `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProfilePreviewPanel — structure', () => {
  it('is a section named by its "Live preview" heading', () => {
    render(<ProfilePreviewPanel expert={makeExpert()} username="jane-doe" headline="" />);

    expect(screen.getByRole('region', { name: 'Live preview' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Live preview' })).toBeInTheDocument();
  });

  it('orders completeness, the live-preview label, card, URL, then snippet', () => {
    render(
      <ProfilePreviewPanel
        expert={makeExpert()}
        username="jane-doe"
        headline="Senior Salesforce Architect"
      />
    );

    const completeness = screen.getByTestId('preview-completeness');
    const label = screen.getByRole('heading', { name: 'Live preview' });
    const card = screen.getByTestId('preview-card');
    const url = screen.getByTestId('preview-url');
    const snippet = screen.getByTestId('preview-snippet');

    expect(card).toContainElement(screen.getByTestId('expert-card'));
    expect(precedes(completeness, label)).toBe(true);
    expect(precedes(label, card)).toBe(true);
    expect(precedes(card, url)).toBe(true);
    expect(precedes(url, snippet)).toBe(true);
  });

  it('scopes the "Live preview" section to the card, URL and snippet — not completeness', () => {
    render(
      <ProfilePreviewPanel
        expert={makeExpert()}
        username="jane-doe"
        headline="Senior Salesforce Architect"
      />
    );

    const preview = screen.getByRole('region', { name: 'Live preview' });
    expect(preview).toContainElement(screen.getByTestId('preview-card'));
    expect(preview).toContainElement(screen.getByTestId('preview-url'));
    expect(preview).toContainElement(screen.getByTestId('preview-snippet'));
    expect(preview).not.toContainElement(screen.getByTestId('preview-completeness'));
  });

  it('keeps the live dot still for reduced-motion users', () => {
    const { container } = render(
      <ProfilePreviewPanel expert={makeExpert()} username="jane-doe" headline="" />
    );

    const dot = container.querySelector('.bg-success');
    expect(dot?.className).toContain('motion-safe:animate-pulse');
    expect(dot?.className).not.toMatch(/(^|\s)animate-pulse/);
  });
});

describe('ProfilePreviewPanel — completeness fields', () => {
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
    const { rerender } = render(
      <ProfilePreviewPanel
        expert={makeExpert({ bio: 'x'.repeat(79) })}
        username="jane-doe"
        headline=""
      />
    );
    expect(screen.getByTestId('field-Bio (min 80 chars)')).toHaveAttribute('data-done', 'false');

    rerender(
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
});

describe('ProfilePreviewPanel — profile URL', () => {
  it('renders the copyable URL only when username has at least 3 chars', () => {
    const { rerender } = render(
      <ProfilePreviewPanel expert={makeExpert()} username="ab" headline="" />
    );
    expect(screen.queryByLabelText('Copy profile URL')).not.toBeInTheDocument();
    expect(screen.queryByTestId('preview-url')).not.toBeInTheDocument();

    rerender(<ProfilePreviewPanel expert={makeExpert()} username="jane-doe" headline="" />);
    expect(screen.getByLabelText('Copy profile URL')).toBeInTheDocument();
    expect(screen.getByTestId('preview-url')).toHaveTextContent('balo.expert/experts/jane-doe');
  });

  it('copies the full https URL, confirms with a toast, and flips the icon', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(<ProfilePreviewPanel expert={makeExpert()} username="jane-doe" headline="" />);

    const button = screen.getByRole('button', { name: 'Copy profile URL' });
    const iconBefore = button.innerHTML;
    await user.click(button);

    expect(writeText).toHaveBeenCalledWith('https://balo.expert/experts/jane-doe');
    expect(toast.success).toHaveBeenCalledWith('Profile URL copied');
    await waitFor(() => expect(button.innerHTML).not.toBe(iconBefore));
  });

  it('tells the expert when the clipboard refuses the copy', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    render(<ProfilePreviewPanel expert={makeExpert()} username="jane-doe" headline="" />);

    await user.click(screen.getByRole('button', { name: 'Copy profile URL' }));

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't copy the URL. Select it and copy it manually."
    );
  });
});

describe('ProfilePreviewPanel — search snippet', () => {
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

  it('titles the snippet with the name and shows the profile URL in success tone', () => {
    render(
      <ProfilePreviewPanel
        expert={makeExpert()}
        username="jane-doe"
        headline="Senior Salesforce Architect"
      />
    );

    const snippet = screen.getByTestId('preview-snippet');
    expect(snippet).toHaveTextContent('Jane Doe · Salesforce Expert');
    const urlLine = screen
      .getAllByText('balo.expert/experts/jane-doe')
      .find((el) => snippet.contains(el));
    expect(urlLine?.className).toContain('text-success-strong');
  });

  it('falls back to a placeholder username in the snippet URL', () => {
    render(<ProfilePreviewPanel expert={makeExpert()} username="" headline="Architect" />);

    expect(screen.getByTestId('preview-snippet')).toHaveTextContent(
      'balo.expert/experts/your-username'
    );
  });
});
