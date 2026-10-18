import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { useForm } from 'react-hook-form';
import { useReducedMotion } from 'motion/react';
import type { ProfileFormData } from './profile-tab';
import { ProfileForm } from './profile-form';

/**
 * Real `motion/react`: `useReducedMotion()` is null on the server and true on the client, so the
 * server markup of the language rows must not depend on it (an `initial` branch hydrates to a
 * different inline style).
 */
vi.mock('motion/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('motion/react')>();
  return { ...actual, useReducedMotion: vi.fn(() => true) };
});
vi.mock('./photo-upload', () => ({ PhotoUpload: () => <div /> }));
vi.mock('./username-input', () => ({ UsernameInput: () => <input /> }));
vi.mock('@/components/country-combobox', () => ({ CountryCombobox: () => <div /> }));
vi.mock('@/components/balo/phone-verification-flow', () => ({
  PhoneVerificationFlow: () => <div />,
}));
vi.mock('@/app/(apply)/expert/apply/_components/chip-picker', () => ({
  ChipPicker: () => <div />,
}));

const DEFAULTS: ProfileFormData = {
  firstName: 'Jane',
  lastName: 'Doe',
  headline: '',
  bio: '',
  username: 'jane-doe',
  industryIds: [],
  languages: [{ languageId: 'lang-en', proficiency: 'native' }],
};

function Harness(): React.JSX.Element {
  const form = useForm<ProfileFormData>({ defaultValues: DEFAULTS });
  return (
    <ProfileForm
      form={form}
      avatarUrl={null}
      expertProfileId="profile-1"
      allLanguages={[{ id: 'lang-en', name: 'English', code: 'en', flagEmoji: '🇬🇧' }]}
      allIndustries={[]}
      countryCode="AU"
      onCountryChange={vi.fn()}
      onAvatarChange={vi.fn()}
      initialPhone={null}
      phoneVerifiedAt={null}
      onPhoneVerified={vi.fn()}
      isDirty={false}
      onReset={vi.fn()}
      onSave={vi.fn()}
      isSaving={false}
    />
  );
}

describe('ProfileForm reduced motion', () => {
  it('server-renders the same markup whether or not reduced motion is known yet', () => {
    vi.mocked(useReducedMotion).mockReturnValue(null);
    const unresolved = renderToStaticMarkup(<Harness />);
    vi.mocked(useReducedMotion).mockReturnValue(true);
    expect(renderToStaticMarkup(<Harness />)).toBe(unresolved);
    expect(unresolved).toContain('English');
  });
});
