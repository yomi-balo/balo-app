import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { Providers } from '@/components/providers';
import { AppFooter } from '@/components/layout/app-footer';
import { Toaster } from '@/components/ui/sonner';
import { getCurrentUser } from '@/lib/auth/session';
import { resolveSiteOrigin } from '@/lib/site-url';
import './globals.css';

const geistSans = localFont({
  src: './fonts/GeistVF.woff',
  variable: '--font-geist-sans',
});
const geistMono = localFont({
  src: './fonts/GeistMonoVF.woff',
  variable: '--font-geist-mono',
});

/**
 * BAL-493 §12.1 — `metadataBase` did not exist anywhere in the app before this. Without it, any
 * page's relative OG/Twitter image URL (e.g. the marketing home's `opengraph-image.tsx`) would
 * resolve relative to whatever host happens to be serving the request rather than an absolute
 * URL — broken when a crawler fetches the image from a different origin than the page.
 * `openGraph`/`twitter` set repo-wide defaults; an individual page's own `metadata` export can
 * still override `title`/`description` per-page as 24+ pages already do.
 *
 * ⚠ Deliberately NO `title.template` here — 24+ pages already export a full title (e.g.
 * `experts/page.tsx`'s `'Find a Salesforce Expert — Balo'`), and a template would append the
 * site name to every one of them. `title` stays a plain string.
 */
export const metadata: Metadata = {
  metadataBase: new URL(resolveSiteOrigin()),
  title: 'Balo — Find Expert Consultants',
  description:
    'B2B marketplace connecting businesses with technology consultants. Cases, Projects, and Packages.',
  openGraph: {
    siteName: 'Balo',
    type: 'website',
    locale: 'en_AU',
  },
  twitter: {
    card: 'summary_large_image',
  },
};

/**
 * BAL-501 — `viewportFit: 'cover'` is what makes `env(safe-area-inset-*)` non-zero on iOS.
 * `width` / `initialScale` restate Next's defaults so adding this export changes nothing else.
 * ⚠ Do NOT add `maximumScale` / `userScalable: false` — blocking pinch-zoom is an a11y defect.
 */
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let user: Awaited<ReturnType<typeof getCurrentUser>> = null;
  try {
    user = await getCurrentUser();
  } catch {
    // Session unavailable (e.g. missing env vars in E2E/CI) — continue without user
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}
        suppressHydrationWarning
      >
        <Providers
          userId={user?.id}
          userTraitsJson={
            user
              ? JSON.stringify({
                  email: user.email,
                  active_mode: user.activeMode,
                  platform_role: user.platformRole,
                })
              : undefined
          }
        >
          {children}
          <AppFooter />
          <Toaster richColors position="top-center" />
        </Providers>
      </body>
    </html>
  );
}
