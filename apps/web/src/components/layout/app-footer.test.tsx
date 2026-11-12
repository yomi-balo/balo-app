import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import { GUEST_CALL_VIEWPORT_ATTRIBUTE } from '@/components/balo/meetings/guest-call-viewport';
import { AppFooter } from './app-footer';

const mockPathname = vi.fn<() => string>();
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname() }));
vi.mock('@/lib/version', () => ({
  getVersionString: () => 'v1.2.3',
  APP_VERSION: { branch: 'main', buildTime: 'now' },
}));

describe('AppFooter', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockPathname.mockReturnValue('/dashboard');
  });

  it('renders the version on an ordinary page', () => {
    render(<AppFooter />);
    expect(screen.getByRole('contentinfo')).toHaveTextContent('v1.2.3');
  });

  it('renders nothing on a member call page', () => {
    mockPathname.mockReturnValue('/meetings/m-1/call');
    render(<AppFooter />);
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
  });

  /**
   * A guest's call shares its URL with the invitation, so the path check cannot see it. The
   * footer hides itself by the call viewport's marker instead; it has to spell that attribute
   * literally for Tailwind, so pin that the literal still matches the component's attribute.
   */
  it('hides itself while a guest call viewport is on the page', () => {
    mockPathname.mockReturnValue('/join/some-token');
    render(<AppFooter />);
    expect(screen.getByRole('contentinfo')).toHaveClass(
      `[body:has([${GUEST_CALL_VIEWPORT_ATTRIBUTE}])_&]:hidden`
    );
  });
});
