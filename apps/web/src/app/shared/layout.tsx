import type { Metadata } from 'next';

interface SharedLayoutProps {
  children: React.ReactNode;
}

/**
 * Defense-in-depth for the magic-link surfaces (BAL-386): a strict `no-referrer`
 * policy across the whole `/shared` subtree so the token-bearing URL is never sent as
 * a `Referer` header to fonts, analytics, or the Join-CTA `/signup` navigation. Set at
 * the layout level; child routes inherit it (they override only title/robots), so the
 * whole subtree is covered.
 */
export const metadata: Metadata = {
  referrer: 'no-referrer',
};

/**
 * Minimal public shell for the BAL-386 shared-proposal surfaces. No dashboard chrome
 * and no auth — these routes are reached by anonymous recipients via an email-bound
 * magic link. Geist fonts + theme tokens are inherited from the root layout's
 * `<body>`; this only provides a centred, atmospheric page frame.
 */
export default function SharedLayout({ children }: Readonly<SharedLayoutProps>): React.JSX.Element {
  return (
    <div className="bg-background relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-primary/10 dark:bg-primary/20 absolute top-0 left-1/4 h-96 w-96 -translate-x-1/2 rounded-full blur-3xl" />
        <div className="absolute top-1/4 right-1/4 h-80 w-80 translate-x-1/2 rounded-full bg-purple-500/5 blur-3xl dark:bg-purple-500/15" />
      </div>
      <main className="relative z-10 mx-auto w-full max-w-3xl px-4 py-8 sm:py-12">{children}</main>
    </div>
  );
}
