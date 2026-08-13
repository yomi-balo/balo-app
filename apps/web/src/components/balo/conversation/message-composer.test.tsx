import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MessageComposer } from './message-composer';
import { MESSAGE_MAX_TEXT } from '@/lib/project-request/conversation-view-types';

type ComposerProps = React.ComponentProps<typeof MessageComposer>;

/**
 * The composer is CONTROLLED (the stage owns per-thread drafts) — this harness
 * plays the stage's role: holds the draft and clears it when a send succeeds.
 */
function Harness({
  initialValue = '',
  onSend,
  ...overrides
}: Readonly<
  Partial<Omit<ComposerProps, 'value' | 'onChange'>> & {
    initialValue?: string;
    onSend?: ComposerProps['onSend'];
  }
>): React.JSX.Element {
  const [value, setValue] = useState(initialValue);
  const send: ComposerProps['onSend'] =
    onSend ??
    (() => {
      setValue('');
      return Promise.resolve(true);
    });
  return (
    <MessageComposer
      expertFirstName="Priya"
      sending={false}
      uploading={null}
      value={value}
      onChange={setValue}
      onSend={(text) =>
        send(text).then((sent) => {
          if (sent) setValue('');
          return sent;
        })
      }
      onAttach={vi.fn()}
      {...overrides}
    />
  );
}

function renderComposer(
  overrides: Partial<Omit<ComposerProps, 'value' | 'onChange'>> & { initialValue?: string } = {}
): {
  onSend: ReturnType<typeof vi.fn>;
  onAttach: ReturnType<typeof vi.fn>;
} {
  const onSend = vi.fn().mockResolvedValue(true);
  const onAttach = vi.fn();
  render(<Harness onSend={onSend} onAttach={onAttach} {...overrides} />);
  return { onSend, onAttach };
}

describe('MessageComposer', () => {
  it('labels the textarea for the active thread', () => {
    renderComposer();
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveAttribute(
      'placeholder',
      'Message Priya…'
    );
  });

  it('prefers the nudge-driven placeholder when provided', () => {
    renderComposer({ placeholder: 'Reply to Priya…' });
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveAttribute(
      'placeholder',
      'Reply to Priya…'
    );
  });

  it('Enter sends the trimmed draft and clears it on success', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, '  Hello there  {Enter}');
    expect(onSend).toHaveBeenCalledWith('Hello there');
    await waitFor(() => expect(textarea).toHaveValue(''));
  });

  it('keeps focus in the textarea after a successful send', async () => {
    const user = userEvent.setup();
    renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'Hello{Enter}');
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(textarea).toHaveFocus();
  });

  it('Shift+Enter inserts a newline without sending', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('line one\nline two');
  });

  it('keeps the draft when send resolves false', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    onSend.mockResolvedValue(false);
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'Important draft{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(textarea).toHaveValue('Important draft');
  });

  it('keeps the draft when send REJECTS (stage owns the toast)', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    onSend.mockRejectedValue(new Error('boom'));
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, 'Still here{Enter}');
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    expect(textarea).toHaveValue('Still here');
  });

  it('never sends an empty/whitespace draft', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer();
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    await user.type(textarea, '   {Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('keeps the textarea FOCUSABLE while sending (readOnly, not disabled)', () => {
    renderComposer({ sending: true, initialValue: 'mid-flight' });
    const textarea = screen.getByRole('textbox', { name: 'Message Priya' });
    expect(textarea).not.toBeDisabled();
    expect(textarea).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('blocks an over-limit draft inline without calling onSend', async () => {
    const user = userEvent.setup();
    const { onSend } = renderComposer({ initialValue: 'x'.repeat(MESSAGE_MAX_TEXT + 1) });
    expect(
      screen.getByText(
        `Keep your message under ${MESSAGE_MAX_TEXT.toLocaleString('en-US')} characters.`
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Message Priya' }), '{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows the subtle counter when approaching the limit (hidden when far below)', () => {
    const nearLimit = MESSAGE_MAX_TEXT - 100;
    renderComposer({ initialValue: 'y'.repeat(nearLimit) });
    expect(
      screen.getByText(
        `${nearLimit.toLocaleString('en-US')}/${MESSAGE_MAX_TEXT.toLocaleString('en-US')}`
      )
    ).toBeInTheDocument();
  });

  it('hides the counter for short drafts', () => {
    renderComposer({ initialValue: 'short draft' });
    expect(screen.queryByText(/\/4,000/)).not.toBeInTheDocument();
  });

  it('shows upload progress and blocks a second attach while uploading', () => {
    renderComposer({ uploading: { fileName: 'scope.pdf', progress: 42 } });
    expect(screen.getByText('Sharing scope.pdf…')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeDisabled();
  });

  it('forwards a picked file to onAttach', async () => {
    const user = userEvent.setup();
    const { onAttach } = renderComposer();
    const file = new File(['x'], 'scope.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]');
    expect(input).not.toBeNull();
    await user.upload(input as HTMLInputElement, file);
    expect(onAttach).toHaveBeenCalledWith(file);
  });

  it('reports focus changes (mobile rail hides while typing)', async () => {
    const user = userEvent.setup();
    const onFocusChange = vi.fn();
    renderComposer({ onFocusChange });
    await user.click(screen.getByRole('textbox', { name: 'Message Priya' }));
    expect(onFocusChange).toHaveBeenCalledWith(true);
    await user.tab();
    expect(onFocusChange).toHaveBeenCalledWith(false);
  });

  it('renders the disabled empty-state contract (default client copy)', () => {
    renderComposer({ disabled: true });
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveAttribute(
      'placeholder',
      'Messaging opens once an expert expresses interest…'
    );
    expect(screen.getByRole('button', { name: 'Attach a file' })).toBeDisabled();
  });

  it('uses the lens-aware disabled placeholder when provided', () => {
    renderComposer({
      disabled: true,
      disabledPlaceholder: 'Messaging opens once you express interest…',
    });
    expect(screen.getByRole('textbox', { name: 'Message Priya' })).toHaveAttribute(
      'placeholder',
      'Messaging opens once you express interest…'
    );
  });
});
