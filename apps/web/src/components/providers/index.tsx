'use client';

import { QueryProvider } from './query-provider';
import { PostHogProvider } from './posthog-provider';
import { ThemeProvider } from './theme-provider';
import { AuthModalProvider } from './auth-modal-provider';

interface ProvidersProps {
  children: React.ReactNode;
  userId?: string;
  userTraitsJson?: string;
}

export function Providers({
  children,
  userId,
  userTraitsJson,
}: Readonly<ProvidersProps>): React.JSX.Element {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <QueryProvider>
        <PostHogProvider userId={userId} userTraitsJson={userTraitsJson}>
          <AuthModalProvider>{children}</AuthModalProvider>
        </PostHogProvider>
      </QueryProvider>
    </ThemeProvider>
  );
}
