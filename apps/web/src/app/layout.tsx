import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Providers } from '@/components/providers';
import { AppFooter } from '@/components/layout/app-footer';
import { Toaster } from '@/components/ui/sonner';
import { getCurrentUser } from '@/lib/auth/session';
import './globals.css';

const geistSans = localFont({
  src: './fonts/GeistVF.woff',
  variable: '--font-geist-sans',
});
const geistMono = localFont({
  src: './fonts/GeistMonoVF.woff',
  variable: '--font-geist-mono',
});

export const metadata: Metadata = {
  title: 'Balo — Find Expert Consultants',
  description:
    'B2B marketplace connecting businesses with technology consultants. Cases, Projects, and Packages.',
};

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
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
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
