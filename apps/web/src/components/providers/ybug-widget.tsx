import Script from 'next/script';

/**
 * Feedback widget (https://ybug.io) for local dev and Vercel preview deploys — never production.
 * Vercel sets `NODE_ENV=production` for every build, preview included, so `NODE_ENV` alone can't
 * tell preview from production; `VERCEL_ENV` (unset locally, 'preview'/'production' on Vercel) is
 * what distinguishes them. `NEXT_PUBLIC_YBUG_ID` is scoped to Preview+Development in Vercel project
 * settings — unset in Production — as defense in depth alongside this gate.
 */
export function YbugWidget(): React.JSX.Element | null {
  const ybugId = process.env.NEXT_PUBLIC_YBUG_ID;
  const isDevOrPreview =
    process.env.NODE_ENV === 'development' || process.env.VERCEL_ENV === 'preview';
  if (!isDevOrPreview || !ybugId) {
    return null;
  }

  return (
    <>
      <Script id="ybug-settings" strategy="afterInteractive">
        {`window.ybug_settings = ${JSON.stringify({ id: ybugId })};`}
      </Script>
      <Script src={`https://widget.ybug.io/button/${ybugId}.js`} strategy="afterInteractive" />
    </>
  );
}
