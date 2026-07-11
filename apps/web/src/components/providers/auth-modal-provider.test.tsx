import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { AuthModalProvider } from './auth-modal-provider';
import { useAuthModal } from '@/hooks/use-auth-modal';

// The provider renders <AuthModal /> as a sibling; stub it so these tests exercise
// only the provider's close-reason state machine (not the full modal/form tree).
vi.mock('@/components/balo/auth/auth-modal', () => ({
  AuthModal: (): null => null,
}));

interface ProbeProps {
  onSuccess?: () => void;
}

/** Consumer that surfaces provider state + drives its actions via buttons. */
function Probe({ onSuccess }: Readonly<ProbeProps>): React.JSX.Element {
  const { isOpen, closeReason, open, close, handleAuthSuccess } = useAuthModal();
  return (
    <div>
      <span data-testid="isOpen">{String(isOpen)}</span>
      <span data-testid="closeReason">{String(closeReason)}</span>
      <button type="button" onClick={() => open()}>
        open
      </button>
      <button type="button" onClick={() => open({ onSuccess })}>
        open-with-success
      </button>
      <button type="button" onClick={() => close()}>
        close
      </button>
      <button type="button" onClick={() => handleAuthSuccess()}>
        success
      </button>
    </div>
  );
}

function renderProbe(onSuccess?: () => void): void {
  render(
    <AuthModalProvider>
      <Probe onSuccess={onSuccess} />
    </AuthModalProvider>
  );
}

const isOpen = (): string => screen.getByTestId('isOpen').textContent ?? '';
const closeReason = (): string => screen.getByTestId('closeReason').textContent ?? '';

describe('AuthModalProvider — close reason', () => {
  it('starts closed with a null close reason', () => {
    renderProbe();
    expect(isOpen()).toBe('false');
    expect(closeReason()).toBe('null');
  });

  it('open() opens the modal and keeps the reason null', async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(isOpen()).toBe('true');
    expect(closeReason()).toBe('null');
  });

  it('close() sets closeReason to "dismissed" and closes', async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'open' }));
    await user.click(screen.getByRole('button', { name: 'close' }));
    expect(isOpen()).toBe('false');
    expect(closeReason()).toBe('dismissed');
  });

  it('handleAuthSuccess() sets closeReason to "success", closes, and fires onSuccess', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    renderProbe(onSuccess);
    await user.click(screen.getByRole('button', { name: 'open-with-success' }));
    await user.click(screen.getByRole('button', { name: 'success' }));
    expect(isOpen()).toBe('false');
    expect(closeReason()).toBe('success');
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('re-opening after a dismiss resets closeReason back to null', async () => {
    const user = userEvent.setup();
    renderProbe();
    await user.click(screen.getByRole('button', { name: 'open' }));
    await user.click(screen.getByRole('button', { name: 'close' }));
    expect(closeReason()).toBe('dismissed');
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(isOpen()).toBe('true');
    expect(closeReason()).toBe('null');
  });
});
