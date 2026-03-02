export default function OnboardingLoading(): React.JSX.Element {
  return (
    <div className="flex w-full max-w-lg flex-col items-center">
      <div className="bg-muted h-8 w-64 animate-pulse rounded" />
      <div className="bg-muted mt-3 h-4 w-48 animate-pulse rounded" />
      <div className="bg-muted mt-8 h-32 w-full animate-pulse rounded-xl" />
      <div className="bg-muted mt-6 h-11 w-48 animate-pulse rounded-lg" />
      <div className="mt-8 flex gap-2">
        <div className="bg-muted h-2 w-2 animate-pulse rounded-full" />
        <div className="bg-muted h-2 w-2 animate-pulse rounded-full" />
        <div className="bg-muted h-2 w-2 animate-pulse rounded-full" />
      </div>
    </div>
  );
}
