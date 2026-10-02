import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/utils';
import { YbugWidget } from './ybug-widget';

const scriptRenders = vi.hoisted((): string[] => []);

// The real `next/script` injects `<script>` tags through a module-level cache that dedupes by
// id/src across renders, so every render after the first in this file would load nothing. This
// stand-in renders each `<Script>` as an element whose props can be asserted instead — and logs
// every render, because rendering `<Script>` at all is what makes Next preload and load it: a
// transient render on a sensitive landing leaks even if the DOM ends up empty.
vi.mock('next/script', () => ({
  default: ({
    id,
    src,
    strategy,
    children,
  }: {
    id?: string;
    src?: string;
    strategy?: string;
    children?: string;
  }) => {
    scriptRenders.push(id ?? src ?? '');
    return (
      <div data-testid="next-script" data-id={id} data-src={src} data-strategy={strategy}>
        {children}
      </div>
    );
  },
}));

// Outside the App Router there is no router context for the real hooks to read. These follow the
// jsdom location, which each test moves with `history.replaceState` — the same committed URL the
// router's hooks report after a client-side navigation.
vi.mock('next/navigation', () => ({
  usePathname: () => globalThis.location.pathname,
  useSearchParams: () => new URLSearchParams(globalThis.location.search),
}));

const destroy = vi.fn();

function navigateTo(url: string): void {
  globalThis.history.replaceState(null, '', url);
}

function renderedScripts(): HTMLElement[] {
  return screen.queryAllByTestId('next-script');
}

describe('YbugWidget', () => {
  beforeEach(() => {
    navigateTo('/');
    scriptRenders.length = 0;
    vi.stubEnv('NEXT_PUBLIC_YBUG_ID', 'abc123');
    vi.stubGlobal('Ybug', { destroy });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    destroy.mockClear();
    navigateTo('/');
  });

  it.each([
    { build: 'local dev', nodeEnv: 'development', vercelEnv: undefined },
    { build: 'a local production build', nodeEnv: 'production', vercelEnv: undefined },
    { build: 'a Vercel preview deploy', nodeEnv: 'production', vercelEnv: 'preview' },
    { build: 'a Vercel production deploy', nodeEnv: 'production', vercelEnv: 'production' },
  ])('loads the widget in $build when NEXT_PUBLIC_YBUG_ID is set', ({ nodeEnv, vercelEnv }) => {
    vi.stubEnv('NODE_ENV', nodeEnv);
    vi.stubEnv('VERCEL_ENV', vercelEnv);

    render(<YbugWidget />);

    const scripts = renderedScripts();
    expect(scripts).toHaveLength(2);
    const [settings, loader] = scripts;
    expect(settings).toHaveAttribute('data-id', 'ybug-settings');
    expect(settings?.textContent).toBe('window.ybug_settings = {"id":"abc123"};');
    expect(loader).toHaveAttribute('data-src', 'https://widget.ybug.io/button/abc123.js');
    expect(scripts.map((script) => script.getAttribute('data-strategy'))).toEqual([
      'afterInteractive',
      'afterInteractive',
    ]);
  });

  it.each([
    { state: 'unset', ybugId: undefined },
    { state: 'empty', ybugId: '' },
  ])('renders nothing when NEXT_PUBLIC_YBUG_ID is $state', ({ ybugId }) => {
    vi.stubEnv('NEXT_PUBLIC_YBUG_ID', ybugId);

    const { container } = render(<YbugWidget />);

    expect(renderedScripts()).toHaveLength(0);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    { landing: 'a guest join link', url: '/join/gJ0kT3n-base64url' },
    { landing: 'the anonymous lobby', url: '/join/m/6f1c2a4e-0d1b-4a8e-9c7d-2b5e8f3a1c90' },
    { landing: 'a review invite', url: '/review/rV1ewT0ken?r=4' },
    { landing: 'a shared proposal', url: '/shared/proposals/pr0p0salT0ken' },
    {
      landing: 'a Stripe SetupIntent return',
      url: '/settings/billing?setup_intent=seti_123&setup_intent_client_secret=seti_123_secret_456&redirect_status=succeeded',
    },
    { landing: 'an admin Lookup search', url: '/admin/lookup?q=dana%40northwind.example' },
  ])('never loads on $landing, even in a production deploy', ({ url }) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_ENV', 'production');
    navigateTo(url);

    const { container } = render(<YbugWidget />);

    expect(scriptRenders).toEqual([]);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    { landing: 'an expert search', url: '/experts?q=agentforce' },
    { landing: 'billing settings without a Stripe return', url: '/settings/billing' },
    { landing: 'the admin Lookup page before a search', url: '/admin/lookup' },
  ])('loads on $landing', ({ url }) => {
    navigateTo(url);

    render(<YbugWidget />);

    expect(renderedScripts()).toHaveLength(2);
  });

  it('tears the widget down for the rest of the document once the URL turns sensitive', () => {
    navigateTo('/admin/lookup');
    const { rerender } = render(<YbugWidget />);
    expect(renderedScripts()).toHaveLength(2);

    navigateTo('/admin/lookup?q=dana%40northwind.example');
    rerender(<YbugWidget />);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(renderedScripts()).toHaveLength(0);

    navigateTo('/admin/lookup');
    rerender(<YbugWidget />);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(renderedScripts()).toHaveLength(0);
  });

  it('stays loaded across client-side navigations between safe URLs', () => {
    navigateTo('/experts');
    const { rerender } = render(<YbugWidget />);

    navigateTo('/experts?q=agentforce');
    rerender(<YbugWidget />);
    navigateTo('/projects');
    rerender(<YbugWidget />);

    expect(destroy).not.toHaveBeenCalled();
    expect(renderedScripts()).toHaveLength(2);
  });
});
