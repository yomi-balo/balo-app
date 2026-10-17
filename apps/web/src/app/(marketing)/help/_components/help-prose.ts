/**
 * Descendant-variant styles for a guide's rendered HTML. This app ships no
 * `@tailwindcss/typography` plugin and preflight flattens headings and list markers, so the
 * sanitiser's allow-list (`p`, `strong`, `em`, `a`, `ul`, `ol`, `li`, `h3`, `h4`, `code`) is
 * restored explicitly. Same approach as `RICH_TEXT_CONTENT_CLASS`, sized for long-form reading.
 */
export const HELP_PROSE_CLASS =
  'text-foreground/90 max-w-[64ch] break-words text-[16.5px] leading-[1.65] [&_p]:mt-3 [&_p:first-child]:mt-0 [&_strong]:text-foreground [&_strong]:font-semibold [&_h3]:text-foreground [&_h3]:mt-6 [&_h3]:mb-1 [&_h3]:text-lg [&_h3]:font-semibold [&_h4]:text-foreground [&_h4]:mt-4 [&_h4]:mb-1 [&_h4]:text-base [&_h4]:font-semibold [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:mt-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:mt-1 [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 [&_code]:bg-mist [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]';
