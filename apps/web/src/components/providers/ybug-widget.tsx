import Script from 'next/script';

/**
 * Dev-only feedback widget (https://ybug.io). Gated on `NODE_ENV` (not just the env var) so it
 * can never load in a Vercel preview/production build, which also inlines `NEXT_PUBLIC_*` vars.
 */
export function YbugWidget(): React.JSX.Element | null {
  const ybugId = process.env.NEXT_PUBLIC_YBUG_ID;
  if (process.env.NODE_ENV !== 'development' || !ybugId) {
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
