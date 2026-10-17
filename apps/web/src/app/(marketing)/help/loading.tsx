/**
 * Route-level loading UI for `/help`: echoes the heading, the two side tabs and a few guide rows
 * with `animate-pulse` blocks, matching the marketing loading house style.
 */
export default function HelpIndexLoading(): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      className="mx-auto max-w-[1080px] px-5 pt-7 pb-12 md:px-10 md:pt-[52px] md:pb-[72px]"
    >
      <span className="sr-only">Loading</span>
      <div className="bg-muted h-10 w-48 animate-pulse rounded motion-reduce:animate-none" />
      <div className="bg-muted mt-3 h-4 w-full max-w-[560px] animate-pulse rounded motion-reduce:animate-none" />
      <div className="mt-6 flex flex-col gap-2 md:mt-8 md:flex-row md:gap-3">
        <div className="bg-muted h-24 animate-pulse rounded-[18px] motion-reduce:animate-none md:h-[172px] md:grow-[1.7] md:basis-0" />
        <div className="bg-muted h-16 animate-pulse rounded-[18px] motion-reduce:animate-none md:h-[172px] md:grow md:basis-0" />
      </div>
      <div className="mt-8 space-y-4 md:mt-[52px]">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-2">
            <div className="bg-muted h-5 w-2/3 animate-pulse rounded motion-reduce:animate-none" />
            <div className="bg-muted h-4 w-full animate-pulse rounded motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}
