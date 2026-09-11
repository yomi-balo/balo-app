import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axe } from 'jest-axe';
import { render, screen } from '@/test/utils';

let pathname = '/admin';
vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
}));

import { AdminSectionNav } from './admin-section-nav';

beforeEach(() => {
  pathname = '/admin';
});

describe('AdminSectionNav', () => {
  it('renders all five chips with the expected hrefs and labels', () => {
    render(<AdminSectionNav />);
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent?.trim())).toEqual([
      'Home',
      'Applications',
      'Lookup',
      'Config & catalogue',
      'Capture health',
    ]);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/admin',
      '/admin/applications',
      '/admin/lookup',
      '/admin/catalogue',
      '/admin/health/capture',
    ]);
  });

  it('marks exactly the active chip with aria-current="page"', () => {
    pathname = '/admin/catalogue';
    render(<AdminSectionNav />);
    const catalogue = screen.getByRole('link', { name: /Config & catalogue/ });
    expect(catalogue).toHaveAttribute('aria-current', 'page');
    const home = screen.getByRole('link', { name: 'Home' });
    expect(home).not.toHaveAttribute('aria-current');
  });

  it('uses <nav aria-label> + links, never role="tab"', () => {
    const { container } = render(<AdminSectionNav />);
    expect(screen.getByRole('navigation', { name: 'Balo admin sections' })).toBeInTheDocument();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
  });

  it('differentiates the active chip by background and colour only, uniform font weight', () => {
    pathname = '/admin/catalogue';
    render(<AdminSectionNav />);
    const active = screen.getByRole('link', { name: /Config & catalogue/ });
    const inactive = screen.getByRole('link', { name: 'Home' });
    expect(active.className).toContain('bg-card');
    expect(active.className).toContain('shadow-sm');
    expect(inactive.className).not.toContain('bg-card');
    const fontClassesOf = (el: HTMLElement): string[] =>
      el.className.split(' ').filter((token) => token.startsWith('font-'));
    expect(fontClassesOf(active)).toEqual(fontClassesOf(inactive));
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<AdminSectionNav />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
