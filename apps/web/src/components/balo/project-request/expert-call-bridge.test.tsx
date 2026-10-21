import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/utils';
import {
  ExpertCallBridgeProvider,
  useExpertProposeTimes,
  useExpertProposeTimesPending,
  useRegisterExpertProposeTimes,
} from './expert-call-bridge';

function Registrar({
  handler,
  pending = false,
}: Readonly<{ handler: (() => void) | null; pending?: boolean }>): null {
  useRegisterExpertProposeTimes(handler, pending);
  return null;
}

function PendingProbe(): React.JSX.Element {
  return <span>{useExpertProposeTimesPending() ? 'pending' : 'idle'}</span>;
}

function Invoker(): React.JSX.Element {
  const proposeTimes = useExpertProposeTimes();
  return (
    <button type="button" disabled={proposeTimes === null} onClick={() => proposeTimes?.()}>
      Propose
    </button>
  );
}

function harness(handler: (() => void) | null, mounted = true): React.JSX.Element {
  return (
    <ExpertCallBridgeProvider>
      {mounted && <Registrar handler={handler} />}
      <Invoker />
    </ExpertCallBridgeProvider>
  );
}

describe('expert-call-bridge', () => {
  it('has no handler until one is registered', () => {
    render(harness(null));
    expect(screen.getByRole('button', { name: 'Propose' })).toBeDisabled();
  });

  it('invokes the LATEST handler after its identity changes, without re-registering in a loop', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(harness(first));
    rerender(harness(second));
    fireEvent.click(screen.getByRole('button', { name: 'Propose' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('clears the handler when the registrant unmounts or passes null', () => {
    const handler = vi.fn();
    const { rerender } = render(harness(handler));
    expect(screen.getByRole('button', { name: 'Propose' })).toBeEnabled();
    rerender(harness(null));
    expect(screen.getByRole('button', { name: 'Propose' })).toBeDisabled();
    rerender(harness(handler));
    rerender(harness(handler, false));
    expect(screen.getByRole('button', { name: 'Propose' })).toBeDisabled();
  });

  it('is inert outside a provider', () => {
    render(
      <>
        <Registrar handler={vi.fn()} />
        <Invoker />
      </>
    );
    expect(screen.getByRole('button', { name: 'Propose' })).toBeDisabled();
  });

  it("reports the registrant's pending state and clears it on unmount", () => {
    const handler = vi.fn();
    const tree = (pending: boolean, mounted = true): React.JSX.Element => (
      <ExpertCallBridgeProvider>
        {mounted && <Registrar handler={handler} pending={pending} />}
        <PendingProbe />
      </ExpertCallBridgeProvider>
    );
    const { rerender } = render(tree(false));
    expect(screen.getByText('idle')).toBeInTheDocument();
    rerender(tree(true));
    expect(screen.getByText('pending')).toBeInTheDocument();
    rerender(tree(true, false));
    expect(screen.getByText('idle')).toBeInTheDocument();
  });

  it('reads idle outside a provider', () => {
    render(
      <>
        <Registrar handler={vi.fn()} pending />
        <PendingProbe />
      </>
    );
    expect(screen.getByText('idle')).toBeInTheDocument();
  });
});
