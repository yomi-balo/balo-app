import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, PROJECT_EVENTS } from '@/lib/analytics';

const REQUEST_ID = 'a0000000-0000-4000-8000-000000000001';
const RELATIONSHIP_ID = 'b0000000-0000-4000-8000-000000000002';
const EXPERT_PROFILE_ID = 'c0000000-0000-4000-8000-000000000003';

vi.mock('server-only', () => ({}));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

// Controlled-textarea stand-in for the code-split TipTap editor, mirroring the
// project-drawer test. Emits the same HTML contract; `validateDescription` requires
// >= 10 chars (matches DESCRIPTION_MIN_TEXT) so the submit gate is exercised.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextEditor: ({
    value,
    onChange,
    placeholder,
    ariaLabel,
  }: {
    value: string;
    onChange: (html: string) => void;
    placeholder?: string;
    ariaLabel?: string;
  }) => {
    const plain = value.replace(/<[^<>]*>/g, '');
    return (
      <textarea
        aria-label={ariaLabel ?? 'editor'}
        placeholder={placeholder}
        value={plain}
        onChange={(e) => onChange(e.target.value ? `<p>${e.target.value}</p>` : '')}
      />
    );
  },
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
  validateDescription: (html: string) => {
    const text = html.replace(/<[^<>]*>/g, '').trim();
    if (text.length < 10) return 'Add a few words about why you’re a strong fit.';
    return null;
  },
  plainTextLength: (html: string) => html.replace(/<[^<>]*>/g, '').trim().length,
  DESCRIPTION_MAX_TEXT: 4000,
}));

const mockSubmitEoi = vi.fn();
const mockWithdrawEoi = vi.fn();
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/submit-eoi', () => ({
  submitEoiAction: (...args: unknown[]) => mockSubmitEoi(...args),
}));
vi.mock('@/app/(dashboard)/projects/[requestId]/_actions/withdraw-eoi', () => ({
  withdrawEoiAction: (...args: unknown[]) => mockWithdrawEoi(...args),
}));

import { EoiEntry } from './eoi-entry';

const mockTrack = vi.mocked(track);
const mockToast = vi.mocked(toast);

const PITCH = 'I have led 5 CPQ migrations end to end.';

describe('EoiEntry — compose state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSubmitEoi.mockResolvedValue({
      success: true,
      transitioned: true,
      relationshipId: RELATIONSHIP_ID,
      expertProfileId: EXPERT_PROFILE_ID,
      timeToEoiMs: 1234,
    });
  });

  it('renders the editor with the invitation framing and a Send button', () => {
    render(<EoiEntry requestId={REQUEST_ID} initialHasEoi={false} initialMessageHtml={null} />);
    expect(screen.getByText('Express your interest')).toBeInTheDocument();
    expect(screen.getByLabelText('Your expression of interest')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send interest/i })).toBeInTheDocument();
  });

  it('keeps the submit button disabled until the draft passes validation', async () => {
    const user = userEvent.setup();
    render(<EoiEntry requestId={REQUEST_ID} initialHasEoi={false} initialMessageHtml={null} />);
    const button = screen.getByRole('button', { name: /send interest/i });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText('Your expression of interest'), 'too short'.slice(0, 5));
    expect(button).toBeDisabled();

    await user.clear(screen.getByLabelText('Your expression of interest'));
    await user.type(screen.getByLabelText('Your expression of interest'), PITCH);
    expect(button).toBeEnabled();
  });

  it('submit success → toast + flip to submitted + track(PROJECT_EOI_SUBMITTED) with timing', async () => {
    const user = userEvent.setup();
    render(<EoiEntry requestId={REQUEST_ID} initialHasEoi={false} initialMessageHtml={null} />);
    await user.type(screen.getByLabelText('Your expression of interest'), PITCH);
    await user.click(screen.getByRole('button', { name: /send interest/i }));

    await waitFor(() => {
      expect(mockSubmitEoi).toHaveBeenCalledWith({
        requestId: REQUEST_ID,
        message: `<p>${PITCH}</p>`,
      });
    });
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_EOI_SUBMITTED, {
      request_id: REQUEST_ID,
      relationship_id: RELATIONSHIP_ID,
      expert_id: EXPERT_PROFILE_ID,
      time_to_eoi_ms: 1234,
    });
    expect(mockToast.success).toHaveBeenCalled();
    // Flipped to submitted state.
    expect(await screen.findByText('Interest sent')).toBeInTheDocument();
  });

  it('submit error → toast.error and keeps the typed draft (no flip)', async () => {
    mockSubmitEoi.mockResolvedValue({ success: false, error: 'Could not submit your interest.' });
    const user = userEvent.setup();
    render(<EoiEntry requestId={REQUEST_ID} initialHasEoi={false} initialMessageHtml={null} />);
    await user.type(screen.getByLabelText('Your expression of interest'), PITCH);
    await user.click(screen.getByRole('button', { name: /send interest/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('Could not submit your interest.')
    );
    expect(screen.queryByText('Interest sent')).not.toBeInTheDocument();
    // Draft preserved in the editor.
    expect(screen.getByLabelText('Your expression of interest')).toHaveValue(PITCH);
  });
});

describe('EoiEntry — submitted state + withdraw', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWithdrawEoi.mockResolvedValue({
      success: true,
      relationshipId: RELATIONSHIP_ID,
      expertProfileId: EXPERT_PROFILE_ID,
    });
  });

  it('renders the submitted pitch (read-only) and a withdraw affordance', () => {
    render(
      <EoiEntry
        requestId={REQUEST_ID}
        initialHasEoi
        initialMessageHtml="<p>My existing pitch</p>"
      />
    );
    expect(screen.getByText('Interest sent')).toBeInTheDocument();
    expect(screen.getByTestId('rt-viewer')).toHaveTextContent('My existing pitch');
    expect(screen.getByRole('button', { name: /withdraw interest/i })).toBeInTheDocument();
  });

  it('withdraw confirm → action + toast + track(PROJECT_EOI_WITHDRAWN) + flips back to compose', async () => {
    const user = userEvent.setup();
    render(<EoiEntry requestId={REQUEST_ID} initialHasEoi initialMessageHtml="<p>My pitch</p>" />);
    await user.click(screen.getByRole('button', { name: /withdraw interest/i }));

    // Confirm dialog appears.
    expect(await screen.findByText('Withdraw your interest?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^withdraw$/i }));

    await waitFor(() => {
      expect(mockWithdrawEoi).toHaveBeenCalledWith({ requestId: REQUEST_ID });
    });
    expect(mockTrack).toHaveBeenCalledWith(PROJECT_EVENTS.PROJECT_EOI_WITHDRAWN, {
      request_id: REQUEST_ID,
      relationship_id: RELATIONSHIP_ID,
      expert_id: EXPERT_PROFILE_ID,
    });
    expect(mockToast.success).toHaveBeenCalled();
    // Flipped back to compose.
    expect(await screen.findByText('Express your interest')).toBeInTheDocument();
  });

  it('withdraw error → toast.error and stays in submitted state', async () => {
    mockWithdrawEoi.mockResolvedValue({
      success: false,
      error: 'You have no active EOI to withdraw.',
    });
    const user = userEvent.setup();
    render(<EoiEntry requestId={REQUEST_ID} initialHasEoi initialMessageHtml="<p>My pitch</p>" />);
    await user.click(screen.getByRole('button', { name: /withdraw interest/i }));
    await user.click(await screen.findByRole('button', { name: /^withdraw$/i }));

    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith('You have no active EOI to withdraw.')
    );
    expect(screen.getByText('Interest sent')).toBeInTheDocument();
  });
});
