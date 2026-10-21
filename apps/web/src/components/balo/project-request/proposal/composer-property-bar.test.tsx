import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { ProposalDocumentView } from '@/app/(dashboard)/projects/[requestId]/_actions/confirm-proposal-document-upload';
import { ComposerPropertyBar } from './composer-property-bar';
import type { ProposalDocumentUploadController } from './proposal-document-uploader';
import type { ProposalPricingMethod } from './proposal-composer-state';

function controller(
  overrides: Partial<ProposalDocumentUploadController> = {}
): ProposalDocumentUploadController {
  return {
    progress: null,
    removingId: null,
    uploadFiles: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const TERMS_DOC: ProposalDocumentView = {
  id: 'doc-1',
  proposalId: 'p1',
  kind: 'terms',
  fileName: 'my-terms.pdf',
  sizeBytes: 2048,
  contentType: 'application/pdf',
  createdAt: new Date('2026-10-01T00:00:00Z'),
} as unknown as ProposalDocumentView;

interface RenderOptions {
  pricingMethod?: ProposalPricingMethod;
  timeframeWeeks?: number | null;
  termsDocuments?: ProposalDocumentView[];
  termsUpload?: ProposalDocumentUploadController;
  trailing?: React.ReactNode;
}

function renderBar(options: RenderOptions = {}): {
  onPricingMethodChange: ReturnType<typeof vi.fn>;
  onTimeframeChange: ReturnType<typeof vi.fn>;
  termsUpload: ProposalDocumentUploadController;
} {
  const onPricingMethodChange = vi.fn();
  const onTimeframeChange = vi.fn();
  const termsUpload = options.termsUpload ?? controller();
  render(
    <ComposerPropertyBar
      pricingMethod={options.pricingMethod ?? 'fixed'}
      onPricingMethodChange={onPricingMethodChange}
      timeframeWeeks={options.timeframeWeeks === undefined ? null : options.timeframeWeeks}
      onTimeframeChange={onTimeframeChange}
      termsDocuments={options.termsDocuments ?? []}
      termsUpload={termsUpload}
      trailing={options.trailing}
    />
  );
  return { onPricingMethodChange, onTimeframeChange, termsUpload };
}

describe('ComposerPropertyBar', () => {
  it('labels the chips from the current state', () => {
    renderBar({ pricingMethod: 'tm', timeframeWeeks: 6 });
    expect(screen.getByRole('button', { name: /time & materials/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About 6 weeks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Balo standard terms' })).toBeInTheDocument();
  });

  it('uses the singular for one week', () => {
    renderBar({ timeframeWeeks: 1 });
    expect(screen.getByRole('button', { name: 'About 1 week' })).toBeInTheDocument();
  });

  it('shows "Add timeframe" when no timeframe is set', () => {
    renderBar({ timeframeWeeks: null });
    expect(screen.getByRole('button', { name: 'Add timeframe' })).toBeInTheDocument();
  });

  it('flips the terms chip once the expert has attached terms', () => {
    renderBar({ termsDocuments: [TERMS_DOC] });
    expect(
      screen.getByRole('button', { name: 'Balo standard and your terms' })
    ).toBeInTheDocument();
  });

  it('renders the trailing slot without imposing a live region', () => {
    renderBar({ trailing: <span>Saved as draft</span> });
    const status = screen.getByText('Saved as draft');
    expect(status.closest('[aria-live]')).toBeNull();
  });

  describe('pricing method', () => {
    it('lists both methods as radios with the current one checked', async () => {
      const user = userEvent.setup();
      renderBar({ pricingMethod: 'fixed' });
      await user.click(screen.getByRole('button', { name: /fixed price/i }));
      const group = screen.getByRole('radiogroup', { name: 'Pricing method' });
      expect(within(group).getByRole('radio', { name: /fixed price/i })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      expect(within(group).getByRole('radio', { name: /time & materials/i })).toHaveAttribute(
        'aria-checked',
        'false'
      );
    });

    it('calls the handler with the picked method and closes the popover', async () => {
      const user = userEvent.setup();
      const { onPricingMethodChange } = renderBar({ pricingMethod: 'fixed' });
      await user.click(screen.getByRole('button', { name: /fixed price/i }));
      await user.click(screen.getByRole('radio', { name: /time & materials/i }));
      expect(onPricingMethodChange).toHaveBeenCalledWith('tm');
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    });
  });

  describe('timeframe', () => {
    it('steps the weeks with the − and + buttons', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: 6 });
      await user.click(screen.getByRole('button', { name: 'About 6 weeks' }));
      await user.click(screen.getByRole('button', { name: 'More weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(7);
      await user.click(screen.getByRole('button', { name: 'Fewer weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(5);
    });

    it('never steps below one week and starts from one when empty', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: 1 });
      await user.click(screen.getByRole('button', { name: 'About 1 week' }));
      await user.click(screen.getByRole('button', { name: 'Fewer weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(1);
    });

    it('starts the + stepper at one week when nothing is set', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: null });
      await user.click(screen.getByRole('button', { name: 'Add timeframe' }));
      await user.click(screen.getByRole('button', { name: 'More weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(1);
    });

    it('keeps digits only, caps the input at three digits and floors it at one', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: null });
      await user.click(screen.getByRole('button', { name: 'Add timeframe' }));
      const input = screen.getByRole('textbox', { name: 'Weeks' });
      await user.type(input, '1a2');
      expect(onTimeframeChange).toHaveBeenLastCalledWith(2);
      await user.clear(input);
      await user.type(input, '0');
      expect(onTimeframeChange).toHaveBeenLastCalledWith(1);
    });

    it('clearing the input writes null', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: 4 });
      await user.click(screen.getByRole('button', { name: 'About 4 weeks' }));
      await user.clear(screen.getByRole('textbox', { name: 'Weeks' }));
      expect(onTimeframeChange).toHaveBeenLastCalledWith(null);
    });

    it('"Remove timeframe" writes null and closes the popover', async () => {
      const user = userEvent.setup();
      const { onTimeframeChange } = renderBar({ timeframeWeeks: 4 });
      await user.click(screen.getByRole('button', { name: 'About 4 weeks' }));
      await user.click(screen.getByRole('button', { name: 'Remove timeframe' }));
      expect(onTimeframeChange).toHaveBeenCalledWith(null);
      expect(screen.queryByRole('textbox', { name: 'Weeks' })).not.toBeInTheDocument();
    });

    it('offers no remove button when there is no timeframe', async () => {
      const user = userEvent.setup();
      renderBar({ timeframeWeeks: null });
      await user.click(screen.getByRole('button', { name: 'Add timeframe' }));
      expect(screen.queryByRole('button', { name: 'Remove timeframe' })).not.toBeInTheDocument();
    });
  });

  describe('terms', () => {
    it('explains the standard terms and offers to attach your own', async () => {
      const user = userEvent.setup();
      renderBar();
      await user.click(screen.getByRole('button', { name: 'Balo standard terms' }));
      expect(screen.getByText(/balo standard terms apply to every proposal/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Attach your terms' })).toBeInTheDocument();
    });

    it('shows the attached file and a Replace action that uploads through the controller', async () => {
      const user = userEvent.setup();
      const termsUpload = controller();
      renderBar({ termsDocuments: [TERMS_DOC], termsUpload });
      await user.click(screen.getByRole('button', { name: 'Balo standard and your terms' }));
      expect(screen.getByText(/my-terms\.pdf/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Replace your terms' })).toBeInTheDocument();

      const input = document.querySelector<HTMLInputElement>('input[type="file"]');
      if (input === null) throw new Error('expected the terms file input');
      const file = new File(['x'], 'new-terms.pdf', { type: 'application/pdf' });
      await user.upload(input, file);
      expect(termsUpload.uploadFiles).toHaveBeenCalledWith([file]);
    });
  });
});
