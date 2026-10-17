import type { HelpSection } from '@/lib/help/types';
import { HelpBlocks } from './help-blocks';
import { HelpScreenshot } from './help-screenshot';

/** One numbered section of a guide. `#step-N` is the deep-link anchor the product links to. */
export function GuideSection({ section }: Readonly<{ section: HelpSection }>): React.JSX.Element {
  const { n, title, blocks, screenshot } = section;
  return (
    <section
      id={`step-${n}`}
      data-step={n}
      aria-labelledby={`step-${n}-title`}
      tabIndex={-1}
      className="focus-visible:ring-ring scroll-mt-24 pt-[52px] outline-none first:pt-0 focus-visible:ring-2"
    >
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="bg-primary/10 text-primary flex size-[30px] shrink-0 items-center justify-center rounded-full text-[13.5px] font-bold"
        >
          {n}
        </span>
        <h2
          id={`step-${n}-title`}
          className="text-foreground m-0 text-xl leading-tight font-semibold tracking-tight md:text-[22px]"
        >
          <span className="sr-only">Section {n}: </span>
          {title}
        </h2>
      </div>
      <div className="mt-3">
        <HelpBlocks blocks={blocks} />
      </div>
      {screenshot === null ? null : <HelpScreenshot image={screenshot} />}
    </section>
  );
}
