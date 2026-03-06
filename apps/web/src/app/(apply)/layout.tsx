import { Logo } from '@/components/layout/logo';
import { UserMenu } from '@/components/layout/user-menu';

export default function ApplyLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="min-h-screen bg-[#F8FAFB] dark:bg-[#0f1117]">
      <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 w-full border-b backdrop-blur">
        <div className="flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
          <Logo />
          <UserMenu />
        </div>
      </header>
      <main className="px-4 py-8 pb-20 sm:px-6 md:pb-8 lg:px-8">{children}</main>
    </div>
  );
}
