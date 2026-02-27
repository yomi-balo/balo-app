'use client';

import { QueryProvider } from './query-provider';
import { PostHogProvider } from './posthog-provider';
import { ThemeProvider } from './theme-provider';
import { AuthModalProvider } from '@/components/auth/auth-modal-provider';
import { AuthModal } from '@/components/auth/auth-modal';

export function Providers({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryProvider>
        <PostHogProvider>
          <AuthModalProvider>
            {children}
            <AuthModal />
          </AuthModalProvider>
        </PostHogProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
