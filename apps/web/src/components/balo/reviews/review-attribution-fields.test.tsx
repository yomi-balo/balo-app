import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor, within } from '@/test/utils';
import { axe } from '@/test/axe';
import { track, REVIEW_EVENTS } from '@/lib/analytics';
import {
  formatReviewAttribution,
  type ReviewBodyVisibility,
  type ReviewCaptureIdentity,
} from '@balo/shared/reviews';
import { buildReviewCaptureSeeds } from '@/test/fixtures/review-capture-seeds';
import { buildAttributionLine } from './attribution-line';
import { ReviewAttributionFields, isReviewerRoleAllowed } from './review-attribution-fields';

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

const trackMock = vi.mocked(track);

interface HarnessProps {
  identity?: ReviewCaptureIdentity;
  note?: string;
  bodyVisibility?: ReviewBodyVisibility;
  role?: string;
  showCompany?: boolean;
  profileRole?: string | null;
  disabled?: boolean;
  onSave?: () => void;
}

/** The parent that owns the three values, plus a Save button OUTSIDE the popover. */
function Harness({
  identity = buildReviewCaptureSeeds().identity,
  note = 'Quoting went from a day to minutes.',
  bodyVisibility: initialVisibility = 'public',
  role: initialRole = '',
  showCompany: initialShowCompany = true,
  profileRole = null,
  disabled = false,
  onSave,
}: Readonly<HarnessProps>): React.JSX.Element {
  const [bodyVisibility, setBodyVisibility] = useState<ReviewBodyVisibility>(initialVisibility);
  const [role, setRole] = useState(initialRole);
  const [showCompany, setShowCompany] = useState(initialShowCompany);
  return (
    <div>
      <ReviewAttributionFields
        identity={identity}
        expertName="Amara"
        note={note}
        draftRating={5}
        bodyVisibility={bodyVisibility}
        onBodyVisibilityChange={setBodyVisibility}
        role={role}
        onRoleChange={setRole}
        showCompany={showCompany}
        onShowCompanyChange={setShowCompany}
        profileRole={profileRole}
        surface="case_surface"
        disabled={disabled}
      />
      <button type="button" onClick={onSave}>
        Save review
      </button>
    </div>
  );
}

const ROLE_ERROR = 'Roles can’t include @ or special characters';

const PREVIEW_HEADER = 'How it appears on Amara’s profile';

function openPreview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  return user.click(screen.getByRole('button', { name: 'Preview' }));
}

describe('ReviewAttributionFields — the Preview', () => {
  beforeEach(() => vi.clearAllMocks());

  afterEach(() => vi.useRealTimers());

  it('opens the real ReviewEntry filled from the draft', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-27T10:00:00Z') });
    const user = userEvent.setup();
    render(<Harness role="RevOps Lead" />);

    await openPreview(user);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(PREVIEW_HEADER)).toBeInTheDocument();
    expect(within(dialog).getByText('Sam K.')).toBeInTheDocument();
    expect(within(dialog).getByText('RevOps Lead @Northwind Logistics')).toBeInTheDocument();
    expect(within(dialog).getByText('Project')).toBeInTheDocument();
    expect(within(dialog).getByText('Oct 2026')).toBeInTheDocument();
    expect(within(dialog).getByRole('img', { name: '5.0 out of 5 stars' })).toBeInTheDocument();
  });

  it('shows a public note in the preview', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openPreview(user);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Quoting went from a day to minutes.')).toBeInTheDocument();
  });

  it('keeps a PRIVATE note out of the preview entirely', async () => {
    const user = userEvent.setup();
    render(<Harness bodyVisibility="private" note="Only for the Balo team." />);
    await openPreview(user);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Sam K.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Only for the Balo team.')).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent('Only for the Balo team.');
  });

  it('reflects the role as it is typed', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(screen.getByRole('textbox', { name: /Your role/ }), 'CRM Lead');
    await openPreview(user);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('CRM Lead @Northwind Logistics')).toBeInTheDocument();
  });

  it('labels the entry a Consultation for a case', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        identity={buildReviewCaptureSeeds({ identity: { engagementKind: 'case' } }).identity}
      />
    );
    await openPreview(user);

    expect(within(await screen.findByRole('dialog')).getByText('Consultation')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openPreview(user);
    await screen.findByRole('dialog');

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes on an outside click', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <p>Elsewhere on the page</p>
        <Harness />
      </div>
    );
    await openPreview(user);
    await screen.findByRole('dialog');

    await user.click(screen.getByText('Elsewhere on the page'));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes when Save is pressed, because Save sits outside the popover', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<Harness onSave={onSave} />);
    await openPreview(user);
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Save review' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('closes from its own close button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openPreview(user);
    await screen.findByRole('dialog');

    await user.click(screen.getByRole('button', { name: 'Close preview' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('tracks review_preview_opened once per open, with the four properties and nothing personal', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await openPreview(user);
    await screen.findByRole('dialog');
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith(REVIEW_EVENTS.PREVIEW_OPENED, {
      surface: 'case_surface',
      has_body: true,
      show_company: true,
      body_visibility: 'public',
    });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trackMock).toHaveBeenCalledTimes(1);

    await openPreview(user);
    await screen.findByRole('dialog');
    expect(trackMock).toHaveBeenCalledTimes(2);
  });

  it('tracks the EFFECTIVE show_company: false when the company is not allowed', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        identity={buildReviewCaptureSeeds({ identity: { companyNameAllowed: false } }).identity}
        note=""
        bodyVisibility="private"
      />
    );

    await openPreview(user);

    expect(trackMock).toHaveBeenCalledWith(REVIEW_EVENTS.PREVIEW_OPENED, {
      surface: 'case_surface',
      has_body: false,
      show_company: false,
      body_visibility: 'private',
    });
  });
});

describe('ReviewAttributionFields — the controls', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the live line exactly as the shared formatter builds it', () => {
    const { identity } = buildReviewCaptureSeeds();
    render(<Harness role="RevOps Lead" />);

    const expected = buildAttributionLine({
      expertName: 'Amara',
      attribution: formatReviewAttribution({
        firstName: identity.reviewerFirstName,
        lastInitial: identity.reviewerLastInitial,
        role: 'RevOps Lead',
        companyName: identity.companyName,
        industryName: identity.industryName,
        showCompany: true,
        companyNameAllowed: true,
      }),
      hasNote: true,
      bodyVisibility: 'public',
    });
    expect(screen.getByText(expected.text)).toBeInTheDocument();
  });

  it('shows the eye icon while the note is public', () => {
    const { container } = render(<Harness />);
    expect(container.querySelector('svg.lucide-eye')).not.toBeNull();
    expect(container.querySelector('svg.lucide-lock')).toBeNull();
  });

  it('shows the lock icon for a private note', () => {
    const { container } = render(<Harness bodyVisibility="private" />);
    expect(container.querySelector('svg.lucide-lock')).not.toBeNull();
    expect(container.querySelector('svg.lucide-eye')).toBeNull();
  });

  it('toggles the note between private and public from the text button', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(
      screen.getByRole('button', { name: 'Send the note to Balo privately instead' })
    );
    expect(screen.getByText(/Only the Balo team sees your note\./)).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Show the note on Amara’s profile instead' })
    );
    expect(screen.queryByText(/Only the Balo team sees your note\./)).not.toBeInTheDocument();
  });

  it('hides the toggle when the note is blank', () => {
    render(<Harness note="   " />);
    expect(
      screen.queryByRole('button', { name: 'Send the note to Balo privately instead' })
    ).not.toBeInTheDocument();
  });

  it('labels the checkbox with the company and toggles it', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const box = screen.getByRole('checkbox', { name: 'Show Northwind Logistics on the review' });
    expect(box).toBeChecked();
    await user.click(box);
    expect(box).not.toBeChecked();
  });

  it.each([
    ['the company is not allowed', { companyNameAllowed: false }],
    ['the company has no name', { companyName: null }],
  ] satisfies readonly [string, Partial<ReviewCaptureIdentity>][])(
    'renders no checkbox when %s',
    (_label, override) => {
      render(<Harness identity={buildReviewCaptureSeeds({ identity: override }).identity} />);
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    }
  );

  it('explains where the role came from, only while it still holds the saved job title', async () => {
    const user = userEvent.setup();
    render(<Harness role="RevOps Lead" profileRole="RevOps Lead" />);
    expect(
      screen.getByText('From your last review. Update it if it’s changed.')
    ).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: /Your role/ }), ' II');
    expect(screen.queryByText(/From your last review/)).not.toBeInTheDocument();
    expect(screen.getByText('We’ll remember it for your next review.')).toBeInTheDocument();
  });

  it('drops the "last review" helper when the seeded role is cleared', async () => {
    const user = userEvent.setup();
    render(<Harness role="RevOps Lead" profileRole="RevOps Lead" />);
    await user.clear(screen.getByRole('textbox', { name: /Your role/ }));
    expect(screen.queryByText(/From your last review/)).not.toBeInTheDocument();
    expect(screen.getByText('We’ll remember it for your next review.')).toBeInTheDocument();
  });

  it('never shows the "last review" helper without a saved job title seed', () => {
    render(<Harness role="RevOps Lead" profileRole={null} />);
    expect(screen.queryByText(/From your last review/)).not.toBeInTheDocument();
    expect(screen.getByText('We’ll remember it for your next review.')).toBeInTheDocument();
  });

  it('flags a role containing @ inline, wired to the field', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: /Your role/ });
    expect(field).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByText(ROLE_ERROR)).not.toBeInTheDocument();

    await user.type(field, 'CTO @Salesforce');
    const error = screen.getByText(ROLE_ERROR);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toContain(error.id);

    await user.clear(field);
    await user.type(field, 'Head of R&D');
    expect(screen.queryByText(ROLE_ERROR)).not.toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'false');
  });

  it.each([
    ['@', true],
    ['\u202E', true],
    ['\u0000', true],
    ['Café Owner', false],
    ['  Head of R&D  ', false],
  ] satisfies readonly [string, boolean][])(
    'isReviewerRoleAllowed(%j) forbidden=%s',
    (role, bad) => {
      expect(isReviewerRoleAllowed(role)).toBe(!bad);
    }
  );

  it('announces the live attribution line politely', () => {
    render(<Harness />);
    const live = screen.getByText(/Your rating and note show on Amara’s profile as/);
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('gives the Preview trigger a 44px hit area', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveClass('min-h-11');
  });

  it('caps the role field at 60 characters', () => {
    render(<Harness />);
    expect(screen.getByRole('textbox', { name: /Your role/ })).toHaveAttribute('maxlength', '60');
  });

  it('disables every control while busy', () => {
    render(<Harness disabled />);
    expect(screen.getByRole('textbox', { name: /Your role/ })).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Send the note to Balo privately instead' })
    ).toBeDisabled();
  });

  it('has no axe violations', async () => {
    const { container } = render(<Harness />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with the preview open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await openPreview(user);
    const dialog = await screen.findByRole('dialog');
    expect(await axe(dialog)).toHaveNoViolations();
  });
});
