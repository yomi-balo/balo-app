import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { useForm } from 'react-hook-form';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProfileFormData } from './profile-tab';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

// Children with their own suites are stubbed to the props this form wires into them.
vi.mock('./photo-upload', () => ({
  PhotoUpload: ({
    initials,
    currentAvatarUrl,
    onUploadComplete,
    onRemoveComplete,
  }: {
    initials: string;
    currentAvatarUrl: string | null;
    onUploadComplete: (url: string) => void;
    onRemoveComplete: () => void;
  }) => (
    <div data-testid="photo-upload" data-initials={initials} data-avatar={currentAvatarUrl ?? ''}>
      <button type="button" onClick={() => onUploadComplete('avatars/new.webp')}>
        stub upload
      </button>
      <button type="button" onClick={onRemoveComplete}>
        stub remove
      </button>
    </div>
  ),
}));

vi.mock('./username-input', () => ({
  UsernameInput: ({
    id,
    value,
    onChange,
    className,
  }: {
    id?: string;
    value: string;
    onChange: (v: string) => void;
    className?: string;
  }) => (
    <input id={id} value={value} className={className} onChange={(e) => onChange(e.target.value)} />
  ),
}));

vi.mock('@/components/country-combobox', () => ({
  CountryCombobox: ({
    value,
    onValueChange,
    className,
  }: {
    value: string;
    onValueChange: (code: string) => void;
    className?: string;
  }) => (
    <button
      type="button"
      role="combobox"
      aria-expanded={false}
      className={className}
      onClick={() => onValueChange('NZ')}
    >
      {value || 'Select your country...'}
    </button>
  ),
}));

vi.mock('@/app/(apply)/expert/apply/_components/chip-picker', () => ({
  ChipPicker: ({
    options,
    selected,
    onChange,
    size,
  }: {
    options: { id: string; label: string }[];
    selected: string[];
    onChange: (next: string[]) => void;
    size?: string;
  }) => (
    <div data-testid="chip-picker" data-size={size}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="checkbox"
          aria-checked={selected.includes(o.id)}
          onClick={() =>
            onChange(
              selected.includes(o.id) ? selected.filter((s) => s !== o.id) : [...selected, o.id]
            )
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('@/components/balo/phone-verification-flow', () => ({
  PhoneVerificationFlow: ({
    mode,
    initialPhone,
    onVerified,
    onCancel,
    focusOnMount,
  }: {
    mode: string;
    initialPhone?: string;
    onVerified: (e164: string) => void;
    onCancel?: () => void;
    focusOnMount?: boolean;
  }) => (
    <div
      data-testid="phone-flow"
      data-mode={mode}
      data-initial-phone={initialPhone ?? ''}
      data-focus-on-mount={String(focusOnMount)}
    >
      <button type="button" onClick={() => onVerified('+64211234567')}>
        stub verify
      </button>
      {onCancel && (
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  ),
}));

import { ProfileForm } from './profile-form';

// Radix Select / cmdk reach for browser APIs jsdom lacks.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

// ── Harness ──────────────────────────────────────────────────────

type FormProps = React.ComponentProps<typeof ProfileForm>;

const LANGUAGES = [
  { id: 'lang-en', name: 'English', code: 'en', flagEmoji: '🇬🇧' },
  { id: 'lang-fr', name: 'French', code: 'fr', flagEmoji: '🇫🇷' },
];
const INDUSTRIES = [
  { id: 'ind-fin', name: 'Financial Services' },
  { id: 'ind-ret', name: 'Retail' },
];

const DEFAULTS: ProfileFormData = {
  headline: '',
  bio: '',
  username: 'jane-doe',
  industryIds: [],
  languages: [],
};

interface HarnessProps extends Partial<Omit<FormProps, 'form'>> {
  defaults?: Partial<ProfileFormData>;
}

/** A real react-hook-form instance; `isDirty` / `onReset` follow the form unless overridden. */
function Harness({ defaults, ...overrides }: Readonly<HarnessProps>): React.JSX.Element {
  const form = useForm<ProfileFormData>({ defaultValues: { ...DEFAULTS, ...defaults } });
  return (
    <ProfileForm
      form={form}
      firstName="Jane"
      lastName="Doe"
      avatarUrl={null}
      expertProfileId="profile-1"
      allLanguages={LANGUAGES}
      allIndustries={INDUSTRIES}
      countryCode="AU"
      onCountryChange={vi.fn()}
      onAvatarChange={vi.fn()}
      initialPhone={null}
      phoneVerifiedAt={null}
      onPhoneVerified={vi.fn()}
      isDirty={form.formState.isDirty}
      onReset={() => form.reset()}
      onSave={vi.fn()}
      isSaving={false}
      {...overrides}
    />
  );
}

/** True when `a` comes before `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function identityCard(): HTMLElement {
  return screen.getByRole('region', { name: 'Identity' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Structure ────────────────────────────────────────────────────

describe('ProfileForm — card order', () => {
  it('stacks Photo, Identity, Public profile, Industries, then Languages', () => {
    render(<Harness />);

    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-labelledby'));
    const names = screen
      .getAllByRole('region')
      .map((r) => within(r).getAllByRole('heading')[0]?.textContent);
    expect(regions.every(Boolean)).toBe(true);
    expect(names).toEqual(['Identity', 'Public profile', 'Industries', 'Languages']);
    expect(precedes(screen.getByTestId('photo-upload'), identityCard())).toBe(true);
  });

  it('labels each card with an eyebrow heading, not an icon tile', () => {
    render(<Harness />);

    for (const name of ['Identity', 'Public profile', 'Industries', 'Languages']) {
      const heading = screen.getByRole('heading', { level: 3, name });
      expect(heading.className).toContain('uppercase');
      expect(heading.previousElementSibling).toBeNull();
    }
  });
});

// ── Photo ────────────────────────────────────────────────────────

describe('ProfileForm — photo', () => {
  it('passes initials and routes upload/remove to onAvatarChange', async () => {
    const user = userEvent.setup();
    const onAvatarChange = vi.fn();
    render(<Harness onAvatarChange={onAvatarChange} avatarUrl="avatars/old.webp" />);

    const photo = screen.getByTestId('photo-upload');
    expect(photo).toHaveAttribute('data-initials', 'JD');
    expect(photo).toHaveAttribute('data-avatar', 'avatars/old.webp');

    await user.click(screen.getByRole('button', { name: 'stub upload' }));
    expect(onAvatarChange).toHaveBeenLastCalledWith('avatars/new.webp');
    await user.click(screen.getByRole('button', { name: 'stub remove' }));
    expect(onAvatarChange).toHaveBeenLastCalledWith(null);
  });
});

// ── Identity ─────────────────────────────────────────────────────

describe('ProfileForm — identity', () => {
  it('shows first and last name read-only, with how to change them', () => {
    render(<Harness />);

    const first = within(identityCard()).getByLabelText(/First name/);
    const last = within(identityCard()).getByLabelText(/Last name/);
    expect(first).toHaveValue('Jane');
    expect(last).toHaveValue('Doe');
    expect(first).toHaveAttribute('readonly');
    expect(last).toHaveAttribute('readonly');
    expect(first).toHaveAccessibleDescription('Contact support to change your name.');
    expect(first).toHaveAttribute('title', 'Contact support to change your name');
    expect(within(identityCard()).getAllByText('· read-only')).toHaveLength(2);
  });

  it('labels the username field and writes edits into the form', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const username = within(identityCard()).getByLabelText('Username');
    expect(username).toHaveValue('jane-doe');
    expect(screen.getByRole('button', { name: 'Reset changes' })).toBeDisabled();

    await user.type(username, 'x');

    expect(username).toHaveValue('jane-doex');
    expect(screen.getByRole('button', { name: 'Reset changes' })).toBeEnabled();
  });

  it('puts Country inside Identity, after the divider, and reports a change', async () => {
    const user = userEvent.setup();
    const onCountryChange = vi.fn();
    render(<Harness onCountryChange={onCountryChange} />);

    const group = within(identityCard()).getByRole('group', { name: 'Country' });
    const combobox = within(group).getByRole('combobox');
    expect(combobox).toHaveTextContent('AU');
    const divider = identityCard().querySelector('hr');
    expect(divider).not.toBeNull();
    if (divider) expect(precedes(divider, group)).toBe(true);

    await user.click(combobox);
    expect(onCountryChange).toHaveBeenCalledWith('NZ');
  });

  it('gives every Identity control one height, so its rows line up', () => {
    render(<Harness initialPhone="+61406431059" phoneVerifiedAt="2026-09-01T00:00:00.000Z" />);

    const card = within(identityCard());
    const controls = [
      card.getByLabelText(/First name/),
      card.getByLabelText(/Last name/),
      card.getByLabelText('Username'),
      card.getByRole('combobox'),
      card.getByLabelText('Phone number'),
    ];
    expect(controls).toHaveLength(5);
    for (const control of controls) {
      const classes = control.className.split(' ');
      expect(classes).toEqual(expect.arrayContaining(['h-11', 'sm:h-9']));
      expect(classes).not.toContain('h-9');
    }
  });

  it('closes with the country and phone helper line', () => {
    render(<Harness />);

    expect(
      within(identityCard()).getByText(
        'Country auto-detects from timezone. Changing your number requires re-verification.'
      )
    ).toBeInTheDocument();
  });
});

// ── Phone ────────────────────────────────────────────────────────

describe('ProfileForm — phone number (verified)', () => {
  const verified = { initialPhone: '+61406431059', phoneVerifiedAt: '2026-09-01T00:00:00.000Z' };

  it('reads as a formatted field with a Verified pill, inside Identity', () => {
    render(<Harness {...verified} />);

    const phone = within(identityCard()).getByLabelText('Phone number');
    expect(phone).toHaveValue('+61 406 431 059');
    expect(phone).toHaveAttribute('readonly');
    const pill = within(identityCard()).getByText('Verified');
    expect(pill).toHaveAttribute('data-tone', 'success');
    expect(screen.queryByTestId('phone-flow')).not.toBeInTheDocument();
    // The number belongs to the Identity card; there is no separate phone card.
    expect(screen.queryByRole('heading', { name: 'Phone Number' })).not.toBeInTheDocument();
  });

  it('opens the verification flow on Change, and Cancel returns focus to Change', async () => {
    const user = userEvent.setup();
    render(<Harness {...verified} />);

    await user.click(screen.getByRole('button', { name: 'Change phone number' }));

    const flow = within(identityCard()).getByTestId('phone-flow');
    expect(flow).toHaveAttribute('data-mode', 'settings');
    // Asked for, so the phone input takes focus.
    expect(flow).toHaveAttribute('data-focus-on-mount', 'true');
    expect(screen.queryByLabelText('Phone number')).not.toBeInTheDocument();
    expect(
      screen.getByText('SMS keeps going to +61 406 431 059 until the new number is verified.')
    ).toBeInTheDocument();

    await user.click(within(flow).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByTestId('phone-flow')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Phone number')).toHaveValue('+61 406 431 059');
    expect(screen.getByRole('button', { name: 'Change phone number' })).toHaveFocus();
  });

  it('shows the newly verified number and hands it to onPhoneVerified', async () => {
    const user = userEvent.setup();
    const onPhoneVerified = vi.fn();
    render(<Harness {...verified} onPhoneVerified={onPhoneVerified} />);

    await user.click(screen.getByRole('button', { name: 'Change phone number' }));
    await user.click(screen.getByRole('button', { name: 'stub verify' }));

    expect(onPhoneVerified).toHaveBeenCalledWith('+64211234567');
    expect(screen.getByLabelText('Phone number')).toHaveValue('+64 21 123 4567');
    expect(screen.getByText('Verified')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Change phone number' })).toHaveFocus()
    );
  });

  it('shows an unparseable stored number as stored', () => {
    render(<Harness initialPhone="12" phoneVerifiedAt="2026-09-01T00:00:00.000Z" />);

    expect(screen.getByLabelText('Phone number')).toHaveValue('12');
  });
});

describe('ProfileForm — phone number (not verified)', () => {
  it('shows the verification flow with no Cancel, no pill and no SMS note', () => {
    render(<Harness initialPhone="+61406431059" phoneVerifiedAt={null} />);

    const flow = within(identityCard()).getByTestId('phone-flow');
    expect(flow).toHaveAttribute('data-initial-phone', '');
    // Mounted on page load mid-card: focusing it would scroll the page away from the top.
    expect(flow).toHaveAttribute('data-focus-on-mount', 'false');
    expect(within(flow).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.queryByText('Verified')).not.toBeInTheDocument();
    expect(screen.queryByText(/SMS keeps going to/)).not.toBeInTheDocument();
  });

  it('swaps to the verified field once the flow succeeds', async () => {
    const user = userEvent.setup();
    const onPhoneVerified = vi.fn();
    render(<Harness onPhoneVerified={onPhoneVerified} />);

    await user.click(screen.getByRole('button', { name: 'stub verify' }));

    expect(onPhoneVerified).toHaveBeenCalledWith('+64211234567');
    expect(screen.queryByTestId('phone-flow')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Phone number')).toHaveValue('+64 21 123 4567');
  });
});

// ── Public profile ───────────────────────────────────────────────

describe('ProfileForm — public profile', () => {
  it('counts headline characters and warns near the limit', async () => {
    const user = userEvent.setup();
    render(<Harness defaults={{ headline: 'x'.repeat(79) }} />);

    const card = screen.getByRole('region', { name: 'Public profile' });
    const headline = within(card).getByLabelText('Headline');
    expect(headline).toHaveAccessibleDescription(
      'Shown under your name in search results and on your profile card.'
    );
    expect(within(card).getByText('79/100').className).toContain('text-muted-foreground');

    await user.type(headline, 'x');
    expect(within(card).getByText('80/100').className).toContain('text-warning-strong');
  });

  it('turns the headline counter destructive at the limit', () => {
    render(<Harness defaults={{ headline: 'x'.repeat(100) }} />);

    expect(screen.getByText('100/100').className.split(' ')).toContain('text-destructive-strong');
  });

  it('edits the bio in a four-row textarea with a 1000 counter', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const bio = screen.getByLabelText('Bio');
    expect(bio.tagName).toBe('TEXTAREA');
    expect(bio).toHaveAttribute('rows', '4');
    expect(screen.getByText('0/1000')).toBeInTheDocument();

    await user.type(bio, 'Hello');
    expect(bio).toHaveValue('Hello');
    expect(screen.getByText('5/1000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset changes' })).toBeEnabled();
  });
});

// ── Industries + languages ───────────────────────────────────────

describe('ProfileForm — industries', () => {
  it('toggles an industry into the form', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const card = screen.getByRole('region', { name: 'Industries' });
    // The lighter settings chip, not the apply wizard's default.
    expect(within(card).getByTestId('chip-picker')).toHaveAttribute('data-size', 'compact');
    const retail = within(card).getByRole('checkbox', { name: 'Retail' });
    expect(retail).toHaveAttribute('aria-checked', 'false');

    await user.click(retail);

    expect(retail).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Reset changes' })).toBeEnabled();
  });
});

describe('ProfileForm — languages', () => {
  it('sits below Industries and invites the first language when empty', () => {
    render(<Harness />);

    const languages = screen.getByRole('region', { name: 'Languages' });
    expect(precedes(screen.getByRole('region', { name: 'Industries' }), languages)).toBe(true);
    expect(within(languages).getByText('Add the languages you consult in.')).toBeInTheDocument();
    expect(screen.queryByText(/No languages/)).not.toBeInTheDocument();
    // The add control shares the eyebrow's header row.
    const add = within(languages).getByRole('button', { name: 'Add language' });
    expect(add.parentElement).toContainElement(
      within(languages).getByRole('heading', { name: 'Languages' })
    );
  });

  it('adds a language from the picker and removes it again', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Add language' }));
    await user.click(await screen.findByRole('option', { name: /French/ }));

    const languages = screen.getByRole('region', { name: 'Languages' });
    const rows = within(languages).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('French');
    expect(
      within(languages).getByRole('combobox', { name: 'French proficiency' })
    ).toHaveTextContent('Intermediate');
    expect(screen.queryByText('Add the languages you consult in.')).not.toBeInTheDocument();

    await user.click(within(languages).getByRole('button', { name: 'Remove French' }));
    expect(within(languages).queryAllByRole('listitem')).toHaveLength(0);
    expect(within(languages).getByText('Add the languages you consult in.')).toBeInTheDocument();
  });

  it('changes a proficiency', async () => {
    const user = userEvent.setup();
    render(
      <Harness defaults={{ languages: [{ languageId: 'lang-en', proficiency: 'intermediate' }] }} />
    );

    await user.click(screen.getByRole('combobox', { name: 'English proficiency' }));
    await user.click(await screen.findByRole('option', { name: 'Native' }));

    expect(screen.getByRole('combobox', { name: 'English proficiency' })).toHaveTextContent(
      'Native'
    );
    expect(screen.getByRole('button', { name: 'Reset changes' })).toBeEnabled();
  });

  it('disables Add language once every language is on the profile', () => {
    render(
      <Harness
        defaults={{
          languages: [
            { languageId: 'lang-en', proficiency: 'native' },
            { languageId: 'lang-fr', proficiency: 'beginner' },
          ],
        }}
      />
    );

    expect(screen.getByRole('button', { name: 'Add language' })).toBeDisabled();
  });

  it('names a language missing from the reference data as unknown', () => {
    render(<Harness defaults={{ languages: [{ languageId: 'gone', proficiency: 'native' }] }} />);

    expect(screen.getByText('Unknown')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove language' })).toBeInTheDocument();
  });
});

// ── Footer ───────────────────────────────────────────────────────

describe('ProfileForm — footer', () => {
  it('puts Reset on the left and Save on the right, both idle until something changes', () => {
    render(<Harness />);

    const reset = screen.getByRole('button', { name: 'Reset changes' });
    const save = screen.getByRole('button', { name: 'Save profile' });
    expect(precedes(reset, save)).toBe(true);
    expect(reset).toBeDisabled();
    expect(save).toBeDisabled();
    expect(reset).toHaveAttribute('data-variant', 'link');
    expect(save).toHaveAttribute('data-variant', 'default');
    expect(save.className).not.toContain('gradient');
  });

  it('wires Save and Reset when dirty', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onReset = vi.fn();
    render(<Harness isDirty onSave={onSave} onReset={onReset} />);

    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await user.click(screen.getByRole('button', { name: 'Reset changes' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('shows Saving… and locks both buttons while saving', () => {
    render(<Harness isDirty isSaving />);

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset changes' })).toBeDisabled();
  });

  it('resets the form fields through the default reset', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const bio = screen.getByLabelText('Bio');
    await user.type(bio, 'Draft');
    await user.click(screen.getByRole('button', { name: 'Reset changes' }));

    expect(bio).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Reset changes' })).toBeDisabled();
  });
});
