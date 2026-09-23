import { Logo } from '@/components/layout/logo';
import { OnboardingSignOut } from './onboarding-sign-out';

interface OnboardingFrameProps {
  /** The header's centre slot — the wizard's step indicator. Omitted on surfaces outside
   *  the step sequence (the join-result landing, the error boundary). */
  progress?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The page chrome every `(onboarding)` surface renders: wordmark left, step progress
 * centre, sign-out right on desktop; wordmark + sign-out over a full-width progress bar on
 * mobile. It is a component rather than the route layout because the progress slot is
 * wizard state, which a server layout above the wizard cannot read.
 */
export function OnboardingFrame({
  progress,
  children,
}: Readonly<OnboardingFrameProps>): React.JSX.Element {
  // `overflow-x-clip` absorbs the wizard's horizontal step slide (and the heading focus
  // that lands mid-slide), which would otherwise scroll the page sideways on mobile.
  return (
    <div className="bg-background flex min-h-dvh flex-col overflow-x-clip">
      <header className="grid grid-cols-[1fr_auto] items-center gap-y-5 px-5 pt-4 md:h-22 md:grid-cols-3 md:px-12 md:pt-0">
        {/* The wordmark alone. `asLink` is off because BAL-361's fail-closed gate traps
            un-onboarded users here; a logo linking to `/` would look like an exit that the
            gate immediately bounces them back from. The real exit is the sign-out beside it. */}
        <Logo
          asLink={false}
          height={30}
          className="justify-self-start [&_img]:h-6 [&_img]:w-auto md:[&_img]:h-[30px]"
        />
        <div className="justify-self-end md:col-start-3 md:row-start-1">
          <OnboardingSignOut />
        </div>
        {progress && (
          <div className="col-span-2 md:col-span-1 md:col-start-2 md:row-start-1 md:justify-self-center">
            {progress}
          </div>
        )}
      </header>
      <main className="flex flex-1 flex-col items-center px-5 pt-7 pb-7 md:justify-center md:px-12 md:pt-0 md:pb-14">
        {children}
      </main>
    </div>
  );
}
