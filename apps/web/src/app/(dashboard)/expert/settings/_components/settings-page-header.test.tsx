import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Clock } from 'lucide-react';
import { SettingsPageHeader } from './settings-page-header';

describe('SettingsPageHeader', () => {
  it('puts the icon on the left of the h1 and its description', () => {
    const { container } = render(
      <SettingsPageHeader
        icon={Clock}
        color="#2563EB"
        title="Schedule"
        description="Set when you're open."
      />
    );

    const heading = screen.getByRole('heading', { level: 1, name: 'Schedule' });
    const description = screen.getByText("Set when you're open.");
    const icon = container.querySelector('svg');

    if (!icon) throw new Error('expected the header icon');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    // Icon first, then the title stack beside it (a row, not a centred hero).
    expect(container.firstElementChild?.className.split(' ')).toEqual(
      expect.arrayContaining(['flex', 'items-start'])
    );
    expect(icon.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      heading.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(container.querySelector('.text-center')).toBeNull();
  });

  it('renders extra lines under the description', () => {
    render(
      <SettingsPageHeader icon={Clock} color="#2563EB" title="Schedule" description="Hours.">
        <p>Hours are set in UTC</p>
      </SettingsPageHeader>
    );

    const extra = screen.getByText('Hours are set in UTC');
    expect(
      screen.getByText('Hours.').compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('merges a className onto the row', () => {
    const { container } = render(
      <SettingsPageHeader
        icon={Clock}
        color="#2563EB"
        title="Rate"
        description="d"
        className="mb-8"
      />
    );
    expect(container.firstElementChild).toHaveClass('mb-8', 'flex');
  });
});
