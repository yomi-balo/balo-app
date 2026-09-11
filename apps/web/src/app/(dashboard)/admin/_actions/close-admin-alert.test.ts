import { describe, it, expect, vi, beforeEach } from 'vitest';

const ALERT_ID = 'b0000000-0000-4000-8000-000000000001';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const mockGetCurrentUser = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
}));

const { mockClose } = vi.hoisted(() => ({ mockClose: vi.fn() }));
vi.mock('@balo/db', () => ({
  adminAlertsRepository: { close: (...a: unknown[]) => mockClose(...a) },
}));

import { closeAdminAlert } from './close-admin-alert';
import { revalidatePath } from 'next/cache';
import { log } from '@/lib/logging';

const ADMIN = { id: 'admin-1', platformRole: 'admin' };
const SUPPORT = { id: 'support-1', platformRole: 'admin' };
const PERMISSION_DENIED = 'You do not have permission to do this.';
const VALID_NOTE = 'Refunded manually via Stripe dashboard';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCurrentUser.mockResolvedValue(ADMIN);
  mockClose.mockResolvedValue({
    outcome: 'closed',
    alert: { id: ALERT_ID, kind: 'session.open_refused' },
    auditId: 'audit-1',
  });
});

describe('closeAdminAlert', () => {
  it('denies an unauthenticated caller before touching the repo', async () => {
    mockGetCurrentUser.mockResolvedValue(null);
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: VALID_NOTE });
    expect(result).toEqual({ success: false, reason: 'forbidden', error: PERMISSION_DENIED });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('denies a viewer without RESOLVE_ADMIN_ALERTS (a plain user)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-2', platformRole: 'user' });
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: VALID_NOTE });
    expect(result).toEqual({ success: false, reason: 'forbidden', error: PERMISSION_DENIED });
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('grants the support role (platformRole "admin") — resolving the queue is the support role', async () => {
    mockGetCurrentUser.mockResolvedValue(SUPPORT);
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: VALID_NOTE });
    expect(result).toEqual({ success: true });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('rejects a note under 8 characters before hitting the repo', async () => {
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: 'short' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('invalid');
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid alertId before hitting the repo', async () => {
    const result = await closeAdminAlert({ alertId: 'nope', note: VALID_NOTE });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('invalid');
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('rejects an unknown extra field (schema is .strict())', async () => {
    const result = await closeAdminAlert({
      alertId: ALERT_ID,
      note: VALID_NOTE,
      // @ts-expect-error — deliberately malformed input for the strict-schema test
      extra: 'nope',
    });
    expect(result.success).toBe(false);
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('trims the note before validating length', async () => {
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: `  ${VALID_NOTE}  ` });
    expect(result).toEqual({ success: true });
    expect(mockClose).toHaveBeenCalledWith(expect.objectContaining({ note: VALID_NOTE }));
  });

  it('closes, logs, and revalidates on success', async () => {
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: VALID_NOTE });
    expect(mockClose).toHaveBeenCalledWith({
      alertId: ALERT_ID,
      actorUserId: ADMIN.id,
      note: VALID_NOTE,
      noteCloseableKinds: expect.arrayContaining(['session.open_refused']),
    });
    expect(log.info).toHaveBeenCalledWith(
      'Admin closed an alert',
      expect.objectContaining({ alertId: ALERT_ID, actorUserId: ADMIN.id })
    );
    expect(revalidatePath).toHaveBeenCalledWith('/admin');
    expect(result).toEqual({ success: true });
  });

  it('refuses a finder-kind row with a discriminated outcome (never a bare error string match)', async () => {
    mockClose.mockResolvedValue({ outcome: 'finder_kind', kind: 'recording.failed' });
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: VALID_NOTE });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('finder_kind');
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('maps already_resolved to its own reason', async () => {
    mockClose.mockResolvedValue({ outcome: 'already_resolved' });
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: VALID_NOTE });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('already_resolved');
  });

  it('maps not_found to its own reason', async () => {
    mockClose.mockResolvedValue({ outcome: 'not_found' });
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: VALID_NOTE });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('not_found');
  });

  it('maps an unexpected repo throw to the generic failure and logs it', async () => {
    mockClose.mockRejectedValue(new Error('DB down'));
    const result = await closeAdminAlert({ alertId: ALERT_ID, note: VALID_NOTE });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('failed');
    expect(log.error).toHaveBeenCalledWith(
      'Failed to close an admin alert',
      expect.objectContaining({ error: 'DB down', actorUserId: ADMIN.id })
    );
  });
});
