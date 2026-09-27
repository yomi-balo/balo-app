import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import RootLayout from './layout';

// `next/font/local` needs a bundler-specific loader for the `.woff` imports in `layout.tsx`;
// under plain Vitest it is stubbed to a fixed CSS variable string, the pattern Next's own
// testing docs recommend for `next/font`.
vi.mock('next/font/local', () => ({
  default: () => ({ variable: 'mock-font-variable' }),
}));

vi.mock('@/components/ui/sonner', () => ({ Toaster: () => <div data-testid="toaster" /> }));
vi.mock('@/components/layout/app-footer', () => ({
  AppFooter: () => <div data-testid="app-footer" />,
}));

/**
 * BAL-504 — `Providers` is stubbed so this test asserts what the LAYOUT actually PASSES DOWN
 * (the `(marketing)/layout.test.tsx` precedent for the same technique). The real `Providers`
 * tree is exercised elsewhere; this file is about the wiring.
 */
vi.mock('@/components/providers', () => ({
  Providers: (props: Record<string, unknown>) => (
    <div data-testid="providers" data-prop-keys={Object.keys(props).sort().join(',')}>
      {props.children as React.ReactNode}
    </div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * BAL-504 — the root layout never reads the session. `analyticsIdentifyPropsFor` and the
 * BAL-553 impersonation-suppression cases are covered in `lib/auth/impersonation.test.ts` and
 * `(marketing)/layout.test.tsx` (the `getCurrentUser` rejection case), where a caller actually
 * has `user` in hand. Mutation-tested: reintroducing a `userId`/`userTraitsJson` prop on
 * `<Providers>` here makes the second `it` below fail.
 */
describe('RootLayout — session-free (BAL-504)', () => {
  it('renders children, the footer and the toaster', () => {
    const ui = RootLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByTestId('app-footer')).toBeInTheDocument();
    expect(screen.getByTestId('toaster')).toBeInTheDocument();
  });

  it('passes Providers only `children` — no identity props', () => {
    const ui = RootLayout({ children: <p>Body</p> });
    render(ui);

    expect(screen.getByTestId('providers').dataset.propKeys).toBe('children');
  });
});
