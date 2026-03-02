import type { Metadata } from 'next';
import localFont from 'next/font/local';
import { Providers } from '@/components/providers';
import { AppFooter } from '@/components/layout/app-footer';
import { Toaster } from '@/components/ui/sonner';
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <Providers>
          {children}
          <AppFooter />
          <Toaster richColors position="top-center" />
        </Providers>
      </body>
    </html>
  );
}
