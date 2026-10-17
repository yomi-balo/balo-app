import type { HelpImage } from '@/lib/help/types';

/**
 * A guide screenshot. Two sibling images are toggled by the app's theme class (`dark:`), not by the
 * OS `prefers-color-scheme`, so the capture always matches the page theme. A plain `<img>` is
 * deliberate: `next/image` adds nothing for fixed, pre-optimised PNGs. Both images carry the
 * alt text: `display:none` already removes the inactive one from the accessibility tree, so the
 * figure reads once in either theme.
 */
export function HelpScreenshot({ image }: Readonly<{ image: HelpImage }>): React.JSX.Element {
  return (
    <figure className="bg-mist border-line m-0 mt-5 rounded-[14px] border p-[14px] md:p-[22px]">
      {/* eslint-disable-next-line @next/next/no-img-element -- fixed, pre-optimised PNG; see docblock */}
      <img
        src={image.lightSrc}
        alt={image.alt}
        loading="lazy"
        decoding="async"
        className="h-auto w-full rounded-[10px] dark:hidden"
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- fixed, pre-optimised PNG; see docblock */}
      <img
        src={image.darkSrc}
        alt={image.alt}
        loading="lazy"
        decoding="async"
        className="hidden h-auto w-full rounded-[10px] dark:block"
      />
    </figure>
  );
}
