/**
 * The Your move rail's Suspense fallback, covering the rail and the project track below it. No
 * hooks and no client boundary: a presentational skeleton that mirrors both panels so nothing
 * jumps when the content streams in. The fallback can't know whether the track will render, so
 * for a viewer with no live projects, or after a failed read, the track placeholder collapses.
 */
export function YourMoveSkeleton(): React.JSX.Element {
  return (
    <>
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
      <section
        aria-hidden="true"
        className="bg-card border-border mb-4 rounded-2xl border px-4 py-[18px] shadow-sm md:px-[22px] md:pt-5 md:pb-[22px]"
      >
        <div className="bg-muted h-5 w-48 animate-pulse rounded motion-reduce:animate-none" />
        <div className="mt-[18px] flex flex-col gap-4 md:grid md:grid-cols-5 md:gap-0">
          {['a', 'b', 'c', 'd', 'e'].map((key) => (
            <div
              key={key}
              className="bg-muted size-[30px] animate-pulse rounded-full motion-reduce:animate-none"
            />
          ))}
        </div>
      </section>
    </>
  );
}
