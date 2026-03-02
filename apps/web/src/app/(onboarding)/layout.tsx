interface OnboardingLayoutProps {
  children: React.ReactNode;
}

export default function OnboardingLayout({
  children,
}: Readonly<OnboardingLayoutProps>): React.JSX.Element {
  return (
    <div className="bg-background relative flex min-h-screen items-center justify-center overflow-hidden">
      {/* Gradient glow orbs for atmosphere */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="bg-primary/15 dark:bg-primary/25 absolute top-1/4 left-1/4 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl" />
        <div className="absolute top-1/3 right-1/4 h-80 w-80 translate-x-1/2 rounded-full bg-purple-500/10 blur-3xl dark:bg-purple-500/20" />
        <div className="absolute bottom-1/4 left-1/3 h-72 w-72 rounded-full bg-pink-500/5 blur-3xl dark:bg-pink-500/15" />
      </div>

      {/* Content */}
      <div className="relative z-10 flex w-full flex-col items-center justify-center px-4 py-8 sm:py-12">
        {/* Branding — logo mark + wordmark */}
        <div className="mb-12 flex flex-col items-center gap-3 text-center">
          <div className="bg-primary flex h-12 w-12 items-center justify-center rounded-xl shadow-lg">
            <span className="text-primary-foreground text-lg font-semibold">B</span>
          </div>
          <h1 className="text-foreground text-2xl font-semibold tracking-tight">balo</h1>
        </div>

        {children}
      </div>
    </div>
  );
}
