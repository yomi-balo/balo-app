import type { HelpImage } from '@/lib/help/types';

/**
 * A guide screenshot. The dark capture is served through `prefers-color-scheme`, so a dark page
 * never shows a white screenshot. A plain `<img>` is deliberate: `next/image` cannot express the
 * `<picture>` art-direction source.
 */
export function HelpScreenshot({ image }: Readonly<{ image: HelpImage }>): React.JSX.Element {
  return (
    <figure className="bg-mist border-line m-0 mt-5 rounded-[14px] border p-[14px] md:p-[22px]">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcSet={image.darkSrc} />
        <img
          src={image.lightSrc}
          alt={image.alt}
          loading="lazy"
          decoding="async"
          className="h-auto w-full rounded-[10px]"
        />
      </picture>
    </figure>
  );
}
