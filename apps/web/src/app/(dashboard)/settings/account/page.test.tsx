import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

const { mockGetCurrentUser, mockRedirect, mockFindDisplayById, mockFindConsent } = vi.hoisted(
  () => ({
    mockGetCurrentUser: vi.fn(),
    mockRedirect: vi.fn(() => {
      throw new Error('REDIRECT');
    }),
    mockFindDisplayById: vi.fn(),
    mockFindConsent: vi.fn(),
  })
);

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: mockRedirect,
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock('@balo/db', () => ({
  usersRepository: {
    findDisplayById: mockFindDisplayById,
    findClientSmsConsent: mockFindConsent,
  },
}));
vi.mock('@/lib/phone/client-sms-consent-actions', () => ({
  getClientSmsConsentStateAction: vi.fn(),
  setClientSmsConsentAction: vi.fn(),
}));
vi.mock('@/components/balo/phone-verification-flow', () => ({
  PhoneVerificationFlow: () => <div data-testid="flow" />,
}));
vi.mock('@/lib/auth/actions/update-name', () => ({ updateNameAction: vi.fn() }));

import AccountSettingsPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation(() => {
    throw new Error('REDIRECT');
  });
  mockGetCurrentUser.mockResolvedValue({
    id: 'user-1',
    firstName: 'Old',
    lastName: 'Cookie',
  });
  mockFindDisplayById.mockResolvedValue({
    id: 'user-1',
    firstName: 'Dana',
    lastName: 'Reyes',
    avatarUrl: null,
  });
  mockFindConsent.mockResolvedValue({
    phone: null,
    phoneVerifiedAt: null,
    clientSmsOptedInAt: null,
  });
});

describe('Account settings page', () => {
  it('redirects a signed-out visitor to login before reading anything', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    await expect(AccountSettingsPage()).rejects.toThrow('REDIRECT');
    expect(mockRedirect).toHaveBeenCalledWith('/login');
    expect(mockFindDisplayById).not.toHaveBeenCalled();
  });

  it('seeds the form from the database, not the possibly-stale session cookie', async () => {
    render(await AccountSettingsPage());
    expect(mockFindDisplayById).toHaveBeenCalledWith('user-1');
    expect(screen.getByLabelText('First name')).toHaveValue('Dana');
    expect(screen.getByLabelText('Last name')).toHaveValue('Reyes');
  });

  it('renders empty fields for an account with no stored name', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', firstName: null, lastName: null });
    mockFindDisplayById.mockResolvedValue({
      id: 'user-1',
      firstName: null,
      lastName: null,
      avatarUrl: null,
    });
    render(await AccountSettingsPage());
    expect(screen.getByLabelText('First name')).toHaveValue('');
    expect(screen.getByLabelText('Last name')).toHaveValue('');
  });

  it('reads consent for the signed-in user and shows the number as On when opted in', async () => {
    mockFindConsent.mockResolvedValue({
      phone: '+61406431059',
      phoneVerifiedAt: new Date('2026-11-01T00:00:00Z'),
      clientSmsOptedInAt: new Date('2026-11-02T00:00:00Z'),
    });
    render(await AccountSettingsPage());
    expect(mockFindConsent).toHaveBeenCalledWith('user-1');
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByText('+61 406 431 059')).toBeInTheDocument();
  });

  it('treats a verified number without consent as not opted in', async () => {
    mockFindConsent.mockResolvedValue({
      phone: '+61406431059',
      phoneVerifiedAt: new Date('2026-11-01T00:00:00Z'),
      clientSmsOptedInAt: null,
    });
    render(await AccountSettingsPage());
    expect(screen.queryByText('On')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Text me at/ })).toBeInTheDocument();
  });

  it('treats consent on an unverified number as not opted in and offers the flow', async () => {
    mockFindConsent.mockResolvedValue({
      phone: '+61406431059',
      phoneVerifiedAt: null,
      clientSmsOptedInAt: new Date('2026-11-02T00:00:00Z'),
    });
    render(await AccountSettingsPage());
    expect(screen.queryByText('On')).not.toBeInTheDocument();
    expect(screen.getByTestId('flow')).toBeInTheDocument();
  });

  it('renders the invitation flow when the consent read finds no row', async () => {
    mockFindConsent.mockResolvedValue(undefined);
    render(await AccountSettingsPage());
    expect(screen.getByTestId('flow')).toBeInTheDocument();
  });

  it('flags the shared number for a user with an expert profile', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'user-1', expertProfileId: 'expert-1' });
    mockFindConsent.mockResolvedValue({
      phone: '+61406431059',
      phoneVerifiedAt: new Date('2026-11-01T00:00:00Z'),
      clientSmsOptedInAt: null,
    });
    render(await AccountSettingsPage());
    expect(screen.getByText('This is also the number on your expert profile.')).toBeInTheDocument();
  });

  it('skips the consent read and hides the text-alert section for an impersonated session', async () => {
    mockGetCurrentUser.mockResolvedValue({
      id: 'user-1',
      firstName: 'Old',
      lastName: 'Cookie',
      isImpersonating: true,
      impersonatorUserId: 'staff-1',
    });
    render(await AccountSettingsPage());
    expect(mockFindConsent).not.toHaveBeenCalled();
    expect(screen.getByLabelText('First name')).toBeInTheDocument();
    expect(screen.queryByText('Text alerts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('flow')).not.toBeInTheDocument();
  });
});
