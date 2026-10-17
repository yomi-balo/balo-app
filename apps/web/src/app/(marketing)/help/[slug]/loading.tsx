/** Route-level loading UI for a guide: breadcrumb, title, summary and body-line placeholders. */
export default function HelpGuideLoading(): React.JSX.Element {
  return (
    <div
      aria-busy="true"
      className="mx-auto max-w-[1080px] px-5 pt-6 pb-12 md:px-10 md:pt-11 md:pb-[72px]"
    >
      <span className="sr-only">Loading</span>
      <div className="max-w-[680px]">
        <div className="bg-muted h-4 w-56 animate-pulse rounded motion-reduce:animate-none" />
        <div className="bg-muted mt-[18px] h-10 w-3/4 animate-pulse rounded motion-reduce:animate-none" />
        <div className="bg-muted mt-3 h-5 w-full animate-pulse rounded motion-reduce:animate-none" />
        <div className="mt-12 space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="bg-muted h-4 w-full animate-pulse rounded motion-reduce:animate-none"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
