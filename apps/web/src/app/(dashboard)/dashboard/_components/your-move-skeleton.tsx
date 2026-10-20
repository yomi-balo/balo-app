/**
 * The Your move rail's Suspense fallback. No hooks and no client boundary: a presentational
 * skeleton that mirrors the rail's panel so nothing jumps when the cards stream in.
 */
export function YourMoveSkeleton(): React.JSX.Element {
  return (
    <section
      aria-busy="true"
      aria-label="Loading your move"
      className="bg-primary/5 border-primary/15 mb-4 rounded-[18px] border pt-[18px] pb-4 pl-4 sm:pt-[22px] sm:pl-[22px]"
    >
      <div className="bg-muted h-5 w-28 animate-pulse rounded motion-reduce:animate-none" />
      <div className="bg-muted mt-2 h-[14px] w-48 animate-pulse rounded motion-reduce:animate-none" />
      <div className="mt-3.5 flex gap-2 pr-4 sm:pr-[22px]">
        {['a', 'b', 'c', 'd'].map((key) => (
          <div
            key={key}
            className="bg-card border-primary/15 h-8 w-20 animate-pulse rounded-full border motion-reduce:animate-none"
          />
        ))}
      </div>
      <div className="mt-3.5 flex gap-3.5 overflow-hidden">
        {['a', 'b', 'c'].map((key) => (
          <div
            key={key}
            className="bg-card border-border h-[190px] w-[292px] shrink-0 animate-pulse rounded-[14px] border motion-reduce:animate-none sm:w-[300px]"
          />
        ))}
      </div>
    </section>
  );
}
