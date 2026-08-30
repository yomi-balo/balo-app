import { Logo } from '@/components/layout/logo';
import { getCurrentUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { toMarketingViewer, type MarketingViewer } from '@/components/marketing/marketing-viewer';
import { ApplyHeaderActions } from './_components/apply-header-actions';

/**
 * BAL-502 §22 — `/expert/apply` is now genuinely viewable signed-out (the gate moved
 * to SUBMIT, not view). This layout used to render `<UserMenu />` unconditionally,
 * which gave an anonymous visitor the literal `'User'`/`'U'` fallback avatar and a
 * "Log out" item they had no session to log out of. It now reads the session
 * server-side — same precedent as `(marketing)/layout.tsx` — and reuses
 * `toMarketingViewer` (one definition of the display projection) so
 * `ApplyHeaderActions` can render the correct variant in the first byte of HTML.
 *
 * Fails OPEN to the signed-out header on a session-read error: this is chrome, never
 * an authorization decision — every protected surface is still gated by middleware
 * and `withAuth`.
 */
export default async function ApplyLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): Promise<React.JSX.Element> {
  // BAL-502 FIX round — `toMarketingViewer` moved INSIDE the try, same reasoning as
  // `(marketing)/layout.tsx`: the "fails open" contract should cover the whole derivation, not
  // just the cookie read.
  let viewer: MarketingViewer | null = null;
  try {
    const user = await getCurrentUser();
    viewer = toMarketingViewer(user);
  } catch (error) {
    log.warn('Apply layout session read failed; rendering the signed-out header', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return (
    <div className="min-h-screen bg-[#F8FAFB] dark:bg-[#0f1117]">
      <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 w-full border-b backdrop-blur">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
          <Logo />
          <ApplyHeaderActions viewer={viewer} />
        </div>
      </header>
      <main className="px-4 py-8 pb-20 sm:px-6 md:pb-8 lg:px-8">{children}</main>
    </div>
  );
}
