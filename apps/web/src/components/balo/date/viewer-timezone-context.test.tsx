import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ViewerTimezoneProvider, useViewerZoneLabel } from './viewer-timezone-context';

function Probe(): React.JSX.Element {
  const label = useViewerZoneLabel();
  return <p data-testid="label">{label ?? 'none'}</p>;
}

function mockDeviceZone(timeZone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    timeZone,
  } as Intl.ResolvedDateTimeFormatOptions);
}

describe('ViewerTimezoneProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has a null label with no provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('label')).toHaveTextContent('none');
  });

  it('exposes the device city while the zones differ', () => {
    mockDeviceZone('Europe/London');
    render(
      <ViewerTimezoneProvider savedTimezone="Australia/Sydney">
        <Probe />
      </ViewerTimezoneProvider>
    );
    expect(screen.getByTestId('label')).toHaveTextContent('London');
  });

  it('is null when the zones are equivalent', () => {
    mockDeviceZone('Australia/Melbourne');
    render(
      <ViewerTimezoneProvider savedTimezone="Australia/Sydney">
        <Probe />
      </ViewerTimezoneProvider>
    );
    expect(screen.getByTestId('label')).toHaveTextContent('none');
  });

  it('is null when no zone is saved', () => {
    mockDeviceZone('Europe/London');
    render(
      <ViewerTimezoneProvider savedTimezone={null}>
        <Probe />
      </ViewerTimezoneProvider>
    );
    expect(screen.getByTestId('label')).toHaveTextContent('none');
  });
});
