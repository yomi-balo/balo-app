'use client';

import { QueryProvider } from './query-provider';
import { PostHogProvider } from './posthog-provider';
import { ThemeProvider } from './theme-provider';
import { AuthModalProvider } from './auth-modal-provider';

export function Providers({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryProvider>
        <PostHogProvider>
          <AuthModalProvider>{children}</AuthModalProvider>
        </PostHogProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
