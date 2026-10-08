import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ApplicationCertWithRelations, CertificationsByCategory } from '@balo/db';
import { CertificationsTab } from './certifications-tab';

// ── Mocks ────────────────────────────────────────────────────────

const { CERT_ID } = vi.hoisted(() => ({ CERT_ID: 'c0000000-0000-4000-8000-000000000001' }));

vi.mock('motion/react', async () => {
  const { createMotionStub } = await import('@/test/motion-stub');
  return createMotionStub();
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mockRefresh }) }));

const mockSaveCertificationsAction = vi.fn();
vi.mock('../_actions/save-certifications', () => ({
  saveCertificationsAction: (...args: unknown[]) => mockSaveCertificationsAction(...args),
}));

// Children with their own suites are stubbed to the props this tab wires into them.
vi.mock('@/app/(apply)/expert/apply/_components/certification-card', () => ({
  CertificationCard: ({
    cert,
    onUpdate,
    onRemove,
  }: {
    cert: { certificationId: string; certName: string };
    onUpdate: (data: { credentialUrl?: string }) => void;
    onRemove: () => void;
  }) => (
    <div data-testid={`cert-card-${cert.certificationId}`}>
      <span>{cert.certName}</span>
      <button type="button" onClick={() => onUpdate({ credentialUrl: 'https://example.com' })}>
        update {cert.certName}
      </button>
      <button type="button" onClick={onRemove}>
        remove {cert.certName}
      </button>
    </div>
  ),
}));

vi.mock('@/app/(apply)/expert/apply/_components/certification-picker-dialog', () => ({
  CertificationPickerDialog: ({
    open,
    onAdd,
  }: {
    open: boolean;
    onAdd: (certificationIds: string[]) => void;
  }) =>
    open ? (
      <div data-testid="cert-picker-dialog">
        <button type="button" onClick={() => onAdd([CERT_ID])}>
          add new cert
        </button>
      </div>
    ) : null,
}));

// ── Fixtures ─────────────────────────────────────────────────────

const INITIAL_CERTS = [
  {
    certificationId: CERT_ID,
    earnedAt: '2024-01-01',
    expiresAt: null,
    credentialUrl: null,
    certification: { id: CERT_ID, name: 'Platform Developer I' },
  },
] as unknown as ApplicationCertWithRelations[];

const CERT_CATEGORIES = [
  {
    category: { id: 'cat-1', name: 'Developer', slug: 'developer' },
    certifications: [{ id: CERT_ID, name: 'Platform Developer I', slug: 'pd1' }],
  },
] as unknown as CertificationsByCategory[];

// ── Tests ────────────────────────────────────────────────────────

describe('CertificationsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveCertificationsAction.mockResolvedValue({ success: true });
  });

  describe('unlocked', () => {
    it('shows the add button and remove control, with no locked banner', () => {
      render(
        <CertificationsTab
          initialCerts={INITIAL_CERTS}
          certCategories={CERT_CATEGORIES}
          trailheadUrl={null}
          skillsLocked={false}
        />
      );
      expect(screen.getByRole('button', { name: /add certification/i })).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /remove platform developer i/i })
      ).toBeInTheDocument();
      expect(screen.queryByText(/expertise is locked after approval/i)).not.toBeInTheDocument();
    });

    it('adds a certification through the picker dialog', async () => {
      const user = userEvent.setup();
      render(
        <CertificationsTab
          initialCerts={[]}
          certCategories={CERT_CATEGORIES}
          trailheadUrl={null}
          skillsLocked={false}
        />
      );
      await user.click(screen.getByRole('button', { name: /add certification/i }));
      await user.click(screen.getByRole('button', { name: /add new cert/i }));
      expect(screen.getByText('Platform Developer I')).toBeInTheDocument();
    });
  });

  describe('locked (BAL-593)', () => {
    it('shows the locked banner and no add or remove control', () => {
      render(
        <CertificationsTab
          initialCerts={INITIAL_CERTS}
          certCategories={CERT_CATEGORIES}
          trailheadUrl={null}
          skillsLocked
        />
      );
      expect(screen.getByText(/expertise is locked after approval/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /add certification/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId(`cert-card-${CERT_ID}`)).not.toBeInTheDocument();
      expect(screen.getByText('Platform Developer I')).toBeInTheDocument();
      expect(screen.getByText('Developer')).toBeInTheDocument();
    });

    it('still sends the unchanged cert list when only the Trailhead URL changes', async () => {
      const user = userEvent.setup();
      render(
        <CertificationsTab
          initialCerts={INITIAL_CERTS}
          certCategories={CERT_CATEGORIES}
          trailheadUrl={null}
          skillsLocked
        />
      );

      await user.type(screen.getByLabelText(/trailhead url/i), 'https://trailhead.me/id/jane');
      await user.click(screen.getByRole('button', { name: /save certifications/i }));

      expect(mockSaveCertificationsAction).toHaveBeenCalledWith({
        certifications: [
          {
            certificationId: CERT_ID,
            earnedAt: '2024-01-01',
            expiresAt: undefined,
            credentialUrl: undefined,
          },
        ],
        trailheadUrl: 'https://trailhead.me/id/jane',
      });
    });

    it('toasts the locked error and refreshes when the server refuses a stale save', async () => {
      mockSaveCertificationsAction.mockResolvedValue({
        success: false,
        code: 'locked',
        error: 'locked message',
      });
      const user = userEvent.setup();
      render(
        <CertificationsTab
          initialCerts={INITIAL_CERTS}
          certCategories={CERT_CATEGORIES}
          trailheadUrl={null}
          skillsLocked
        />
      );

      await user.type(screen.getByLabelText(/trailhead url/i), 'x');
      await user.click(screen.getByRole('button', { name: /save certifications/i }));

      expect(mockRefresh).toHaveBeenCalled();
    });
  });
});
