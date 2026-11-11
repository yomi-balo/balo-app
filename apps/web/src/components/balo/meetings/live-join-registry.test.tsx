import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  LiveJoinRegistryProvider,
  useLiveJoinOnPage,
  useLiveJoinRegistration,
} from './live-join-registry';

const URL_A = '/meetings/m-a/call';

function Registrant({
  joinUrl,
  enabled = true,
}: Readonly<{ joinUrl: string; enabled?: boolean }>): null {
  useLiveJoinRegistration(joinUrl, enabled);
  return null;
}

function Probe({ joinUrl }: Readonly<{ joinUrl: string | null }>): React.JSX.Element {
  return <span data-testid="probe">{String(useLiveJoinOnPage(joinUrl))}</span>;
}

function probeValue(): string | null {
  return screen.getByTestId('probe').textContent;
}

describe('LiveJoinRegistry', () => {
  it('is on the page while any registrant mounts, and off once every one unmounts', () => {
    const tree = (first: boolean, second: boolean): React.JSX.Element => (
      <LiveJoinRegistryProvider>
        <Probe joinUrl={URL_A} />
        {first ? <Registrant key="first" joinUrl={URL_A} /> : null}
        {second ? <Registrant key="second" joinUrl={URL_A} /> : null}
      </LiveJoinRegistryProvider>
    );
    const { rerender } = render(tree(true, true));
    expect(probeValue()).toBe('true');

    rerender(tree(false, true));
    expect(probeValue()).toBe('true');

    rerender(tree(false, false));
    expect(probeValue()).toBe('false');
  });

  it('never registers while enabled is false', () => {
    render(
      <LiveJoinRegistryProvider>
        <Probe joinUrl={URL_A} />
        <Registrant joinUrl={URL_A} enabled={false} />
      </LiveJoinRegistryProvider>
    );
    expect(probeValue()).toBe('false');
  });

  it('moves the registration when joinUrl changes', () => {
    const tree = (joinUrl: string): React.JSX.Element => (
      <LiveJoinRegistryProvider>
        <Probe joinUrl={URL_A} />
        <Registrant joinUrl={joinUrl} />
      </LiveJoinRegistryProvider>
    );
    const { rerender } = render(tree(URL_A));
    expect(probeValue()).toBe('true');

    rerender(tree('/meetings/m-b/call'));
    expect(probeValue()).toBe('false');
  });

  it('only reports the url that was registered', () => {
    render(
      <LiveJoinRegistryProvider>
        <Probe joinUrl="/meetings/other/call" />
        <Registrant joinUrl={URL_A} />
      </LiveJoinRegistryProvider>
    );
    expect(probeValue()).toBe('false');
  });

  it('is false for a null joinUrl', () => {
    render(
      <LiveJoinRegistryProvider>
        <Probe joinUrl={null} />
        <Registrant joinUrl={URL_A} />
      </LiveJoinRegistryProvider>
    );
    expect(probeValue()).toBe('false');
  });

  it('returns false and does not throw without a provider', () => {
    expect(() =>
      render(
        <>
          <Probe joinUrl={URL_A} />
          <Registrant joinUrl={URL_A} />
        </>
      )
    ).not.toThrow();
    expect(probeValue()).toBe('false');
  });
});
