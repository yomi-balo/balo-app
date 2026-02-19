import { render, RenderOptions, RenderResult } from '@testing-library/react';
import { ReactElement } from 'react';

// Add providers here (QueryClientProvider, etc.)
function AllProviders({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

const customRender = (ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>): RenderResult =>
  render(ui, { wrapper: AllProviders, ...options });

export * from '@testing-library/react';
export { customRender as render };
